import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";

import { handleApiError } from "@/lib/error-handler";
import {
  checkRateLimit,
  rateLimits,
  getRateLimitIdentifier,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { getGachaStats, getGachaCardOwnerStats } from "@/lib/dashboard-data";
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() が false を返すため getDb() は一切呼ばれず、既存の
// supabase-js 経路が従来どおり実行される。dashboard-data.ts 側の各関数
// （getGachaStats / getGachaCardOwnerStats）は既に pg 直結対応済みのため、この
// route に残る唯一の supabase-js 呼び出し（streamer 取得）のみを対応する。
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { streamers as streamersTable } from "@/lib/db/schema";

/**
 * streamer 取得の pg 直結実装 (#663)
 * gacha-history/route.ts の fetchStreamerIdPg と同一パターン（PostgREST 実装
 * との対応・エラー時の扱いも同じ）。
 */
async function fetchStreamerIdPg(twitchUserId: string): Promise<{ id: string } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "gacha-stats(streamer)",
      { idempotent: true },
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * GET /api/gacha-stats
 * Gacha statistics endpoint (streamer only)
 * Returns draw counts and rate comparisons for a given period
 *
 * ガチャ統計エンドポイント（配信者専用）
 * 指定期間の排出回数と排出率比較を返す
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      );
    }

    // Streamer-only endpoint
    // 配信者専用エンドポイント
    if (!canUseStreamerFeatures(session)) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      );
    }

    const identifier = await getRateLimitIdentifier(
      request,
      session.twitchUserId
    );
    const rateLimitResult = await checkRateLimit(
      rateLimits.gachaStatsGet,
      identifier
    );

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

    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period");

    // Validate period parameter
    // period パラメータのバリデーション
    // "byCard": 全期間のカード別所持ユーザー統計（「カード別」タブ用）
    if (period !== "7d" && period !== "30d" && period !== "byCard") {
      return NextResponse.json(
        { error: "Invalid period. Must be '7d', '30d', or 'byCard'." },
        { status: 400 }
      );
    }

    // #663: 読み取り専用のため isPgReadEnabled() で分岐。
    const streamer = await fetchStreamerIdPg(session.twitchUserId);

    if (!streamer) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_NOT_FOUND },
        { status: 404 }
      );
    }

    if (period === "byCard") {
      const cardOwnerStats = await getGachaCardOwnerStats(streamer.id);
      return NextResponse.json(cardOwnerStats);
    }

    const stats = await getGachaStats(streamer.id, period);
    return NextResponse.json(stats);
  } catch (error) {
    return handleApiError(error, "Fetching gacha stats");
  }
}
