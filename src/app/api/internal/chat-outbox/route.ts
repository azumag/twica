import { NextRequest, NextResponse } from "next/server";
import { ERROR_MESSAGES } from "@/lib/constants";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { logger } from "@/lib/logger.server";
import { constantTimeEqual } from "@/lib/crypto-utils";
import { deliverChatNotificationSlice } from "@/lib/services/chat-notification-delivery";
import { dispatchDueChatNotifications } from "@/lib/services/chat-notification-dispatch";

/**
 * Issue #1665: 専用Chat Delivery Queue Workerが、Service Binding
 * (CHAT_APP) 経由で呼ぶ狭い内部境界。
 *
 * `deliver`（指定batchの1slice配送）と `dispatch-due`（回収sweep用の
 * enqueue）の2アクションだけを受け付ける。どちらも配送結果の永続化まで
 * 同期awaitしてからレスポンスを返す（runInBackground/waitUntilへ戻さない。
 * それをやると本Issueが修正しようとしている「HTTPレスポンス寿命への依存」を
 * この内部境界で再現してしまう）。
 *
 * 公開経路からも到達し得る（route.tsとして存在する以上URLは推測可能）ため、
 * Service Bindingを使うことだけを認証とせず、環境別のCHAT_DELIVERY_SECRET
 * による共有シークレット認証を必須にする。未設定時はfail-closed（500）。
 * このrouteはガチャ再抽選・カード再付与・ポイント再消費・overlay再broadcast
 * を一切行わない。送り先・本文・SQL・強制cursor・強制sentを外部から
 * 指定できるフィールドは持たない（batchId/limit以外の入力は拒否する）。
 */

const MAX_BODY_BYTES = 2_000;
const MAX_BATCH_ID_LENGTH = 200;
const DEFAULT_DISPATCH_DUE_LIMIT = 25;
const MAX_DISPATCH_DUE_LIMIT = 25;
// 回収sweep 1周期（初期案1分）の間、同じ行への重複enqueueを防ぐための予約窓。
// CHAT_OUTBOX_LEASE_SECONDS(60秒)より長く取り、1回のsweep漏れでも次回で
// 回収できる余裕を持たせる。
const DUE_WAKE_RESERVATION_SECONDS = 120;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

type DeliverRequestBody = { action: "deliver"; batchId: string };
type DispatchDueRequestBody = { action: "dispatch-due"; limit?: number };
type InternalChatOutboxRequestBody = DeliverRequestBody | DispatchDueRequestBody;

function isValidBatchId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BATCH_ID_LENGTH;
}

/**
 * 未知フィールドを黙って無視せず拒否する。強制cursor・強制sent・任意送信先等の
 * 隠しパラメータを将来のコード変更で誤って解釈してしまう余地をなくす。
 */
function hasOnlyAllowedKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => (allowed as readonly string[]).includes(key));
}

function parseRequestBody(raw: string): InternalChatOutboxRequestBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;

  if (body.action === "deliver") {
    if (!hasOnlyAllowedKeys(body, ["action", "batchId"])) return null;
    if (!isValidBatchId(body.batchId)) return null;
    return { action: "deliver", batchId: body.batchId };
  }

  if (body.action === "dispatch-due") {
    if (!hasOnlyAllowedKeys(body, ["action", "limit"])) return null;
    if (body.limit !== undefined && (!Number.isInteger(body.limit) || (body.limit as number) < 1)) {
      return null;
    }
    return { action: "dispatch-due", limit: body.limit as number | undefined };
  }

  return null;
}

export async function POST(request: NextRequest) {
  // fail-closed: シークレット自体が未設定なら、設定忘れで誰でもアクセスできる
  // 事故を防ぐため500を返す（eventsub-replay/route.tsと同じ方針）。
  const expectedSecret = process.env.CHAT_DELIVERY_SECRET;
  if (!expectedSecret) {
    logger.error("[chat-outbox-internal] CHAT_DELIVERY_SECRET is not configured");
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  // 秘密情報はヘッダーで運び、URL・クエリ文字列には入れない（ログ・アクセスログへの
  // 漏出を避けるため）。
  const providedSecret = request.headers.get("x-chat-delivery-secret") || "";
  if (!providedSecret || !constantTimeEqual(expectedSecret, providedSecret)) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const identifier = await getRateLimitIdentifier(request);
  const rateLimitResult = await checkRateLimit(rateLimits.chatOutboxDelivery, identifier);
  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      {
        status: 429,
        headers: {
          ...NO_STORE_HEADERS,
          "X-RateLimit-Limit": String(rateLimitResult.limit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(rateLimitResult.reset),
        },
      },
    );
  }

  const rawBody = await request.text();
  if (!rawBody || rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_REQUEST },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const body = parseRequestBody(rawBody);
  if (!body) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.INVALID_REQUEST },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (body.action === "deliver") {
    const outcome = await deliverChatNotificationSlice(body.batchId);
    return NextResponse.json({ outcome }, { status: 200, headers: NO_STORE_HEADERS });
  }

  const limit = Math.min(
    MAX_DISPATCH_DUE_LIMIT,
    Math.max(1, body.limit ?? DEFAULT_DISPATCH_DUE_LIMIT),
  );
  const result = await dispatchDueChatNotifications(limit, DUE_WAKE_RESERVATION_SECONDS);
  return NextResponse.json({ result }, { status: 200, headers: NO_STORE_HEADERS });
}
