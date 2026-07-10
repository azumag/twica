import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError } from "@/lib/error-handler";
import {
  checkRateLimit,
  rateLimits,
  getRateLimitIdentifier,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { getGachaStats, getGachaCardOwnerStats } from "@/lib/dashboard-data";
// #663: streamers.id 単一行取得の pg 直結経路（読み取り専用）。
// getDb() は withDbRetry の queryFn 内で呼ぶ規約（src/lib/db/retry.ts 参照）。
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { streamers as streamersTable } from "@/lib/db/schema";

/**
 * セッションの twitch_user_id から streamers.id を取得する pg 直結実装 (#663)
 *
 * src/app/api/gacha-history/route.ts の getStreamerIdByTwitchUserIdPg と
 * 同一のクエリ・パリティ判断（DB エラーも 0 行も等しく null → 404 扱い、
 * 読み取り専用のため idempotent: true）。ルートごとに自己完結させる
 * YAGNI 方針（共有ヘルパーファイルを新設しない）により、あえて重複させている。
 */
async function getStreamerIdByTwitchUserIdPg(
  twitchUserId: string
): Promise<{ id: string } | null> {
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
      "gacha-stats:getStreamerId",
      { idempotent: true }
    );
    return rows[0] ?? null;
  } catch {
    // 既存実装は取得エラーを握りつぶすため、pg 経路も同じ挙動（null → 404）にする
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

    // #663: 読み取り専用のため isPgReadEnabled() で分岐。フラグ未設定時
    // （既定 'postgrest'）は else 節の既存 supabase-js 実装が従来どおり動く。
    let streamer: { id: string } | null;
    if (isPgReadEnabled()) {
      streamer = await getStreamerIdByTwitchUserIdPg(session.twitchUserId);
    } else {
      const supabaseAdmin = getSupabaseAdmin();
      const { data } = await supabaseAdmin
        .from("streamers")
        .select("id")
        .eq("twitch_user_id", session.twitchUserId)
        .maybeSingle();
      streamer = data;
    }

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
