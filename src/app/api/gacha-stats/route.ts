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

    const supabaseAdmin = getSupabaseAdmin();
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

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
