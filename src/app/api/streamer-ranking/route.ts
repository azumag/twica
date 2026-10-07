import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";

import { handleApiError } from "@/lib/error-handler";
import {
  checkRateLimit,
  rateLimits,
  getRateLimitIdentifier,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
// streamers.id の解決は src/lib/user-data.ts の共有ヘルパーへ集約する
// （#690 で route ごとの個別実装を1箇所へ統合した経緯があるため、API 追加時もそれを再利用する）。
import { getStreamerIdByTwitchUserId } from "@/lib/user-data";
import { getStreamerRanking } from "@/lib/services/streamer-ranking";

/**
 * GET /api/streamer-ranking
 * 配信者本人向けの匿名化済み他チャンネル比較ランキング (Issue #742 子B)
 *
 * - 認可: セッション必須 + canUseStreamerFeatures(session)（/api/gacha-stats と同一ゲート）
 * - 自 streamer 解決: session.twitchUserId -> streamers.twitch_user_id
 * - クエリパラメータなし（4メトリクス × 全期間を1リクエストで返す。分割しない）
 * - 他チャンネルの識別子は DB 関数の応答に含まれず、この route は何も付加しない
 *   （匿名化境界は DB 関数の応答生成時点で完結する）
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
      rateLimits.streamerRankingGet,
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

    const streamer = await getStreamerIdByTwitchUserId(session.twitchUserId);

    if (!streamer) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_NOT_FOUND },
        { status: 404 }
      );
    }

    const outcome = await getStreamerRanking(streamer.id);

    if (!outcome.available) {
      // 集計 migration よりアプリが先に deploy された窓 (42883 / 42P01)。
      // PACK_RENAME_NOT_READY / STATS_REFRESH_NOT_READY と同じ扱いで、
      // 例外にせず「準備中」として 503 を返す（snapshot が空の通常ケースは
      // 200 + computedAt: null で返るため、ここには来ない）。
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_RANKING_NOT_READY },
        { status: 503 }
      );
    }

    return NextResponse.json(outcome.response);
  } catch (error) {
    return handleApiError(error, "Fetching streamer ranking");
  }
}
