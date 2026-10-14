import { NextRequest, NextResponse } from "next/server";
import { executeDashboardRpcPg } from "@/lib/dashboard-data";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import {
  checkRateLimit,
  getRateLimitIdentifier,
  rateLimits,
  retryAfterSeconds,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import type { ApiRateLimitResponse } from "@/types/api";
import { isValidStreamerId } from "@/lib/overlay-realtime/contract";

// Issue #934: docich 同志カードコーナー（設計 docs/features/doushi-card-corner.md §6）。
// opt-in 済みの配信者に限り、集計済みランキングだけを返す。生の履歴行・内部 id
// （user_twitch_id / card_id）は返さない。
//
// 公開の可否は streamers.publish_card_ranking のオプトインで決まり、判定は DB 側の
// wrapper get_published_card_ranking が行う（route 側のフィルタには依存しない）。
// 未 opt-in は SQLSTATE P0002 で返り、この route が 404 へ写像する。未知の streamer と
// 同じ応答にして、どのチャンネルが opt-in 済みかを探れないようにする。

const CARD_RANKING_PERIODS = new Set(["all", "7d", "30d"]);
const DEFAULT_CARD_RANKING_PERIOD = "all";
const DEFAULT_CARD_RANKING_LIMIT = 10;
// limit の上限は RPC（public.get_card_ranking）と同じ値にする。ここを外すと RPC が
// 不正値で例外を投げて 500 になるため、入力境界で 400 に落とす。
const MAX_CARD_RANKING_LIMIT = 50;
// wrapper が未 opt-in / 未知の streamer に対して返す SQLSTATE（no_data_found）。
const CARD_RANKING_NOT_PUBLISHED_SQLSTATE = "P0002";

interface RouteParams {
  params: Promise<{ streamerId: string }>;
}

/**
 * RPC の JSONB をそのまま返す。列の組み立て（allowlist）は SQL 側で行い、この
 * route は値を足さない。RPC が壊れて null / 非オブジェクトを返した場合は 503 に
 * 落として docich 側の fail-closed（コーナー開始 skip）へ委ねる。
 */
function isCardRankingPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { streamerId } = await params;
    if (!isValidStreamerId(streamerId)) {
      return NextResponse.json(
        { error: "Invalid streamer ID" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const periodParam = searchParams.get("period");
    if (periodParam !== null && !CARD_RANKING_PERIODS.has(periodParam)) {
      return NextResponse.json(
        { error: "Invalid period parameter" },
        { status: 400 }
      );
    }
    const period = periodParam ?? DEFAULT_CARD_RANKING_PERIOD;

    const limitParam = searchParams.get("limit");
    let limit = DEFAULT_CARD_RANKING_LIMIT;
    if (limitParam !== null) {
      if (!/^\d+$/.test(limitParam)) {
        return NextResponse.json(
          { error: "Invalid limit parameter" },
          { status: 400 }
        );
      }
      const parsed = Number(limitParam);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_CARD_RANKING_LIMIT) {
        return NextResponse.json(
          { error: "Invalid limit parameter" },
          { status: 400 }
        );
      }
      limit = parsed;
    }

    const identifier = await getRateLimitIdentifier(request);
    const rateLimitResult = await checkRateLimit(
      rateLimits.overlayCardRankingGet,
      identifier
    );
    if (!rateLimitResult.success) {
      return NextResponse.json<ApiRateLimitResponse>(
        {
          error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
          retryAfter: retryAfterSeconds(rateLimitResult.reset),
        },
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

    const { data, error } = await executeDashboardRpcPg(
      "get_published_card_ranking(pg)",
      async (sql) => {
        const rows = await sql<Array<{ result: unknown }>>`
          select get_published_card_ranking(${streamerId}::uuid, ${period}, ${limit}) as result
        `;
        return rows[0]?.result;
      }
    );

    if (error) {
      // P0002 (no_data_found) = 未 opt-in または未知の streamer。両者を同じ 404 に
      // して、どのチャンネルが公開を許可しているかを探れないようにする。
      if (error.code === CARD_RANKING_NOT_PUBLISHED_SQLSTATE) {
        return NextResponse.json(
          { error: "Card ranking is not published" },
          { status: 404, headers: { "Cache-Control": "no-store" } }
        );
      }
      // 42883 (undefined_function) = RPC 未デプロイのデプロイ窓。取得不能は
      // fail-closed（503）にし、docich 側はコーナー開始を skip する。
      if (error.code === "42883") {
        return NextResponse.json(
          { error: "Card ranking RPC is not available" },
          { status: 503, headers: { "Cache-Control": "no-store" } }
        );
      }
      return handleDatabaseError(error, "Overlay Card Ranking API");
    }

    if (!isCardRankingPayload(data)) {
      return NextResponse.json(
        { error: "Card ranking payload is unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error, "Overlay Card Ranking API");
  }
}
