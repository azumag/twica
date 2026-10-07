import { NextRequest, NextResponse } from "next/server";
import { ERROR_MESSAGES } from "@/lib/constants";
import { constantTimeEqual } from "@/lib/crypto-utils";
import { logger } from "@/lib/logger.server";
import { runStatsRefresh } from "@/lib/services/stats-refresh";

/**
 * Issue #741: ランキング統計バッチの内部実行境界。
 *
 * workers/stats-aggregator (DB 接続を持たない cron Worker) が毎時叩く
 * 薄いルート。認証後に refresh_streamer_ranking() を呼ぶだけ。
 * PostgREST / dual-driver 分岐は持たない (現行 PlanetScale 単一 runtime)。
 *
 * 公開経路からも到達し得るため、環境別の STATS_REFRESH_SECRET による
 * 共有シークレット認証を必須にする。未設定時は fail-closed (500)。
 * シークレットは x-stats-refresh-secret ヘッダーで運ぶ
 * (src/app/api/internal/chat-outbox/route.ts と同一規約)。
 *
 * maintenance 中はブロックする (config/maintenance-write-surfaces.json に
 * maintenanceBehavior: 'block' で登録。snapshot 再計算は DB 書き込みであり、
 * 他の書き込み API と同様にメンテ中は状態を失わず延期する)。
 */

const STATS_REFRESH_SECRET_HEADER = "x-stats-refresh-secret";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" } as const;

export async function POST(request: NextRequest) {
  // fail-closed: シークレット自体が未設定なら 500 を返す
  // (eventsub-replay / chat-outbox と同じ方針)。
  const expectedSecret = process.env.STATS_REFRESH_SECRET;
  if (!expectedSecret) {
    logger.error("[stats-refresh-internal] STATS_REFRESH_SECRET is not configured");
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const providedSecret = request.headers.get(STATS_REFRESH_SECRET_HEADER) || "";
  if (!providedSecret || !constantTimeEqual(expectedSecret, providedSecret)) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const startedAt = Date.now();
  try {
    const outcome = await runStatsRefresh();
    const durationMs = Date.now() - startedAt;

    if (!outcome.available) {
      // デプロイ窓: 集計 migration 未適用。503 で縮退させる
      // (PACK_RENAME_NOT_READY と同じ判断)。
      logger.warn("[stats-refresh-internal] aggregation objects not deployed yet", {
        code: outcome.code,
      });
      return NextResponse.json(
        { error: ERROR_MESSAGES.STATS_REFRESH_NOT_READY, code: outcome.code },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }

    logger.info("[stats-refresh-internal] refresh completed", {
      skipped: outcome.skipped,
      reason: outcome.reason,
      snapshotCount: outcome.snapshotCount,
      durationMs,
    });
    return NextResponse.json(
      {
        skipped: outcome.skipped,
        reason: outcome.reason,
        snapshotCount: outcome.snapshotCount,
        computedAt: outcome.computedAt,
        durationMs,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    // 失敗時はトランザクションごとロールバックされ旧 snapshot が残る
    // (関数側の設計)。ここでは structured log に残すのみ。
    logger.error("[stats-refresh-internal] refresh failed", {
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
