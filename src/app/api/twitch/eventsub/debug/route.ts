import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { handleApiError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";
import { logger } from "@/lib/logger.server";
import { validateCSRFToken } from "@/lib/csrf";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { fetchTwitchApi } from "@/lib/twitch/app-token";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

/**
 * EventSubサブスクリプションのデバッグ用エンドポイント
 * 現在のサブスクリプション状態を詳細に取得する
 */
// EventSubサブスクリプションの型定義（デバッグ用）
type EventSubSubscription = {
  id: string;
  status: string;
  type: string;
  condition: { broadcaster_user_id: string; reward_id?: string };
  transport: { method: string; callback: string };
  created_at: string;
};

// すべてのEventSubサブスクリプションを取得（デバッグ用・ページネーション対応）
// subscribe/route.tsと同様に配列を返すように統一
async function getAllSubscriptions(): Promise<EventSubSubscription[]> {
  const allData: EventSubSubscription[] = [];
  let cursor: string | undefined;

  do {
    const url = cursor
      ? `${TWITCH_API_URL}/eventsub/subscriptions?after=${cursor}`
      : `${TWITCH_API_URL}/eventsub/subscriptions`;

    const response = await fetchTwitchApi(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch subscriptions: ${response.status}`);
    }

    const data = await response.json();
    allData.push(...data.data);
    cursor = data.pagination?.cursor;
  } while (cursor);

  // 配列を返す（totalはallData.lengthから取得可能）
  return allData;
}

// 指定broadcasterのEventSubサブスクリプションのみを取得（デバッグ用・ページネーション対応）
// subscribe/route.ts の getSubscriptionsByUserId と同じ方式: Twitch APIの
// user_idパラメータで絞り込むことで全件取得より効率的に取得する (#831)。
// user_idフィルタは broadcaster_user_id 以外(to_broadcaster_user_id等)にも
// マッチするため、呼び出し側で condition.broadcaster_user_id の一致を
// 別途確認すること。
async function getSubscriptionsByBroadcaster(
  broadcasterUserId: string
): Promise<EventSubSubscription[]> {
  const allData: EventSubSubscription[] = [];
  let cursor: string | undefined;

  do {
    const baseUrl = `${TWITCH_API_URL}/eventsub/subscriptions?user_id=${broadcasterUserId}`;
    const url = cursor ? `${baseUrl}&after=${cursor}` : baseUrl;

    const response = await fetchTwitchApi(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch subscriptions: ${response.status}`);
    }

    const data = await response.json();
    allData.push(...data.data);
    cursor = data.pagination?.cursor;
  } while (cursor);

  return allData;
}

export async function GET() {
  const session = await getSession();

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    // ページネーションを使ってすべてのサブスクリプションを取得
    const allSubscriptions = await getAllSubscriptions();

    // このbroadcasterのサブスクリプションのみフィルタ
    const mySubscriptions = allSubscriptions.filter(
      (sub) => sub.condition.broadcaster_user_id === session.twitchUserId
    );

    // 全サブスクリプション情報を返す（デバッグ用）
    // totalはallSubscriptions.lengthから取得（subscribe/route.tsと同じ方式）
    return NextResponse.json({
      broadcasterId: session.twitchUserId,
      clientId: process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID,
      expectedCallbackUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`,
      total: allSubscriptions.length,
      mySubscriptions: mySubscriptions.map((sub: EventSubSubscription) => ({
        id: sub.id,
        status: sub.status,
        type: sub.type,
        rewardId: sub.condition.reward_id,
        callback: sub.transport.callback,
        createdAt: sub.created_at,
      })),
    });
  } catch (error) {
    return handleApiError(error, "EventSub Debug GET");
  }
}

// 特定のEventSubサブスクリプションを削除
export async function DELETE(request: NextRequest) {
  // 状態変更 API（EventSub 解除）のため CSRF 検証を最初に行う (#831)。
  // 認証済みユーザーの Cookie を悪用したクロスサイト削除を防止する。
  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
  }

  const session = await getSession();

  // レートリミットチェック (#831: 従来未設定だったため追加)。
  // このエンドポイントは subscribe/route.ts の DELETE と同じEventSub購読を
  // 操作するため、専用キーで別枠にすると合計の変更可能回数が実質2倍になって
  // しまう。同じ rateLimits.eventsubSubscribePost バケットを共有し、Twitch側の
  // 実質的な変更レート予算を一本化する。
  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.eventsubSubscribePost, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimitResult.limit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(rateLimitResult.reset),
        },
      }
    );
  }

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const subscriptionId = searchParams.get("id");
    const deleteAll = searchParams.get("all") === "true";

    if (deleteAll) {
      // すべてのサブスクリプションを削除
      // user_idで絞り込んだページネーション対応の取得を使う (#831)。旧実装は
      // 1ページ分の生fetchのみで、購読数がページ上限を超えると一部しか削除
      // されないのに成功報告してしまっていた。また全app分を取得してから
      // クライアント側フィルタするより、Twitch API側で絞り込む方が効率的。
      const candidateSubscriptions = await getSubscriptionsByBroadcaster(session.twitchUserId);
      const mySubscriptions = candidateSubscriptions.filter(
        (sub) => sub.condition.broadcaster_user_id === session.twitchUserId
      );

      const results = [];
      for (const sub of mySubscriptions) {
        const deleteResponse = await fetchTwitchApi(
          `${TWITCH_API_URL}/eventsub/subscriptions?id=${sub.id}`,
          { method: "DELETE" },
        );
        results.push({
          id: sub.id,
          status: deleteResponse.status,
          success: deleteResponse.status === 204,
        });
        logger.info(`Deleted subscription: id=${sub.id}, status=${deleteResponse.status}`);
      }

      return NextResponse.json({
        message: `Deleted ${results.filter(r => r.success).length}/${mySubscriptions.length} subscriptions`,
        results,
      });
    }

    if (!subscriptionId) {
      return NextResponse.json({ error: "Missing subscription id" }, { status: 400 });
    }

    // 所有権検証 (#831): このbroadcasterの購読であることをTwitch側の実データで
    // 確認してから削除する。旧実装はid以外を一切検証しておらず、他broadcasterの
    // subscriptionIdが分かれば（ログ・スクショ等の別経路での漏出が前提だが）
    // app access tokenで削除できてしまっていた。
    // user_idで絞り込んだ取得を使うことで、削除対象のid1件を探すためだけに
    // app全体(全streamer分)のサブスクリプションを毎回列挙することを避ける。
    const candidateSubscriptions = await getSubscriptionsByBroadcaster(session.twitchUserId);
    const targetSubscription = candidateSubscriptions.find((sub) => sub.id === subscriptionId);

    if (!targetSubscription || targetSubscription.condition.broadcaster_user_id !== session.twitchUserId) {
      logger.warn(`[EventSub Debug DELETE] Ownership mismatch or not found: id=${subscriptionId} requested by ${session.twitchUserId}`);
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // 単一のサブスクリプションを削除
    const deleteResponse = await fetchTwitchApi(
      `${TWITCH_API_URL}/eventsub/subscriptions?id=${subscriptionId}`,
      { method: "DELETE" },
    );

    if (deleteResponse.status === 204) {
      logger.info(`Deleted subscription: id=${subscriptionId}`);
      return NextResponse.json({ success: true, message: "Subscription deleted" });
    } else {
      const error = await deleteResponse.json().catch(() => ({}));
      return NextResponse.json(
        { error: "Failed to delete subscription", details: error },
        { status: deleteResponse.status }
      );
    }
  } catch (error) {
    return handleApiError(error, "EventSub Debug DELETE");
  }
}
