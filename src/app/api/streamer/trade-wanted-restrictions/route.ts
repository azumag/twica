// PUT /api/streamer/trade-wanted-restrictions
//
// トレードの「交換対象の制限」(配信者ごとの許可リスト)を保存する。
// 設計: tasks/plans/trade-wanted-restriction.md v4 §6。判定そのものは出品 API・応諾 RPC・
// オークション RPC が行い、この API は設定(ルール)の書き込みだけを担う。
//
// body: { allowedWantedCardIds: string[] }
//   - セッションの配信者が持つ「交換対象リスト」を、許可カードの集合へ丸ごと置換する。
//   - 空配列 = ルールの削除(制限なしに戻す)。
//   - 配信者はセッションから解決する(body では受けない。他人の設定を書く余地が無い。
//     streamerId が body に含まれても無視する)。
//
// POST /api/streamer/settings とは別 route にする: あちらは boolean 列の部分更新で、
// 集合の置換(1トランザクション・配信者ロック)とは契約が違うため。
// メンテナンスモード中の書き込みは src/middleware.ts が一律ブロックする。

import { NextRequest, NextResponse } from "next/server";

import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { getDb } from "@/lib/db/client";
import { isPgMissingTableError } from "@/lib/db/errors";
import { withDbRetry } from "@/lib/db/retry";
import { streamers as streamersTable } from "@/lib/db/schema";
import { logger } from "@/lib/logger.server";
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from "@/lib/rate-limit";
import { validateContentType } from "@/lib/request-validation";
import { canUseStreamerFeatures, getSession } from "@/lib/session";
import {
  replaceTradeWantedRestriction,
  TRADE_WANTED_RESTRICTION_MAX_ITEMS,
} from "@/lib/trade-wanted-restrictions";
import { normalizeCanonicalUuid } from "@/lib/uuid-validation";
import { eq } from "drizzle-orm";

const NO_STORE = { "Cache-Control": "private, no-store" };
const respond = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: NO_STORE });

export async function PUT(request: NextRequest) {
  const contentTypeError = validateContentType(request, "application/json");
  if (contentTypeError) return contentTypeError;

  const csrf = await validateCSRFToken(request);
  if (!csrf.valid) return respond({ error: ERROR_MESSAGES.FORBIDDEN }, 403);

  const session = await getSession();
  const limit = await checkRateLimit(
    rateLimits.streamerSettings,
    await getRateLimitIdentifier(request, session?.twitchUserId),
  );
  if (!limit.success) return respond({ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED }, 429);
  if (!session || !canUseStreamerFeatures(session)) {
    return respond({ error: ERROR_MESSAGES.UNAUTHORIZED }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond({ error: ERROR_MESSAGES.INVALID_REQUEST }, 400);
  }
  const parsed = parseBody(body);
  if (!parsed) return respond({ error: ERROR_MESSAGES.INVALID_REQUEST }, 400);

  try {
    const [streamer] = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, session.twitchUserId))
          .limit(1);
      },
      "trade-wanted-restrictions:streamer",
      { idempotent: true },
    );
    if (!streamer) return respond({ error: ERROR_MESSAGES.UNAUTHORIZED }, 401);

    const result = await replaceTradeWantedRestriction({
      streamerId: streamer.id,
      allowedWantedCardIds: parsed.allowedWantedCardIds,
    });
    if (result.kind === "error") {
      // 他配信者のカードと存在しないカードは区別しない(404)。
      return respond({ error: "Not found" }, 404);
    }
    return respond({ success: true, ruleRemoved: result.ruleRemoved }, 200);
  } catch (error) {
    // migration 前(テーブルが無い)は保存できない。保存成功を装わず 503 にし、
    // UI は楽観反映を戻す。それ以外の失敗も内部情報を返さない。
    if (isPgMissingTableError(error)) {
      return respond({ error: "Trade restrictions are not available yet", unavailable: true }, 503);
    }
    logger.error("PUT /api/streamer/trade-wanted-restrictions failed", { error });
    return respond({ error: ERROR_MESSAGES.INTERNAL_ERROR }, 500);
  }
}

/** body の形を検証し、UUID を小文字へ正規化する。不正なら null。 */
function parseBody(body: unknown): { allowedWantedCardIds: string[] } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { allowedWantedCardIds } = body as Record<string, unknown>;
  if (!Array.isArray(allowedWantedCardIds)) return null;
  if (allowedWantedCardIds.length > TRADE_WANTED_RESTRICTION_MAX_ITEMS) return null;
  const allowed = new Set<string>();
  for (const value of allowedWantedCardIds) {
    if (typeof value !== "string") return null;
    const normalized = normalizeCanonicalUuid(value);
    // 出品カード自身を許可に入れることは許す(リストは出品カードに依存しない)。
    // 「自分自身を求むにして出品」は出品 API の TRADE_SAME_CARD が止める。
    if (!normalized) return null;
    allowed.add(normalized);
  }
  return { allowedWantedCardIds: [...allowed] };
}
