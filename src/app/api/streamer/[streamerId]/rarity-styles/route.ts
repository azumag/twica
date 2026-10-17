import { type NextRequest, NextResponse } from "next/server";

import { PRIVATE_NO_STORE_CACHE_CONTROL } from "@/lib/cache-control";
import { handleApiError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";
import { logger } from "@/lib/logger.server";
import type { RarityStyles } from "@/lib/rarity-styles";
// -----------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): PlanetScale 接続。GET は読み取り専用のため
// getDb() は withDbRetry の queryFn 内で呼ぶ規約（src/lib/db/retry.ts 参照）。
// -----------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { isPgMissingNamedColumnError } from "@/lib/db/errors";
import { streamers as streamersTable } from "@/lib/db/schema";

interface RouteParams {
  params: Promise<{ streamerId: string }>;
}

// sound-settings と同じ公開GETパイロット設定。settings POST 側の Cache-Tag purge は
// まだ結線していないため、まずは 1 秒だけ edge cache して同時リクエストの
// request collapsing を有効にする（長TTL化は tag purge と同時に行う）。
const RARITY_STYLES_CACHE_CONTROL = "public, max-age=0, s-maxage=1";

interface RarityStylesRow {
  rarity_styles: unknown;
}

/**
 * GET の DB アクセス結果を表す判別共用体。
 * - 'ok': 取得成功（streamer が null の場合は行が存在しない = 404 対象）
 * - 'degraded': DB エラー。オーバーレイのカード描画そのものは止めないため、
 *   呼び出し元は「スタイル未設定」と同じ空マップへデグレードする。
 */
type RarityStylesLookup =
  | { kind: "ok"; streamer: RarityStylesRow | null }
  | { kind: "degraded" };

/**
 * 配信者のカスタムレアリティ表示スタイルを取得する（Issue #1783 フェーズ2）。
 *
 * - streamers を id で 1 行取得（id は PK のため LIMIT 1 + rows[0] ?? null）。
 * - 列が未デプロイ（migration 未適用）の環境では SQLSTATE 42703 と列名を同時に
 *   確認して空スタイルへ縮退し、オーバーレイを落とさない。
 */
async function getRarityStylesPg(streamerId: string): Promise<RarityStylesLookup> {
  const selectRarityStyles = () =>
    withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ rarity_styles: streamersTable.rarity_styles })
          .from(streamersTable)
          .where(eq(streamersTable.id, streamerId))
          .limit(1);
      },
      "getRarityStyles",
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );

  try {
    const rows = await selectRarityStyles();
    return { kind: "ok", streamer: rows[0] ?? null };
  } catch (error) {
    if (isPgMissingNamedColumnError(error, ["rarity_styles"])) {
      // 列が無い＝全レアリティが既定表示。行の有無は判定できないが、
      // デプロイ窓中は空マップを返して通常描画を維持する（fail-open ではなく
      // 「設定がまだ無い」と同じ状態に倒す）。
      logger.info("Streamer Rarity Styles API: rarity_styles column not deployed yet", {
        streamerId,
      });
      return { kind: "ok", streamer: { rarity_styles: {} } };
    }
    logger.warn("Streamer Rarity Styles API: falling back to empty style map", {
      streamerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "degraded" };
  }
}

/**
 * 配信者のカスタムレアリティ表示スタイルを取得する。
 * 認証不要のパブリックエンドポイント（オーバーレイから呼び出される）。
 * sound-settings と別 endpoint にするのは、効果音設定と表示スタイルが別の設定領域で
 * あり、将来のキャッシュ無効化を片方に波及させないため。
 *
 * GET /api/streamer/[streamerId]/rarity-styles
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { streamerId } = await params;

    if (!streamerId) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_ID_REQUIRED },
        {
          status: 400,
          headers: { "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL },
        }
      );
    }

    const lookup = await getRarityStylesPg(streamerId);

    if (lookup.kind === "degraded") {
      return NextResponse.json(
        { rarityStyles: {} },
        { headers: { "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL } }
      );
    }

    const streamer = lookup.streamer;

    if (!streamer) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_NOT_FOUND },
        {
          status: 404,
          headers: { "Cache-Control": PRIVATE_NO_STORE_CACHE_CONTROL },
        }
      );
    }

    // JSONB の値は信頼しない。描画側（getRarityStylePresentation）も 1 エントリずつ
    // 検証するが、ここでは「マップとして扱える形」だけを保証する。
    const value = streamer.rarity_styles;
    const rarityStyles: RarityStyles =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as RarityStyles)
        : {};

    return NextResponse.json(
      { rarityStyles },
      { headers: { "Cache-Control": RARITY_STYLES_CACHE_CONTROL } }
    );
  } catch (error) {
    const response = await handleApiError(error, "Streamer Rarity Styles API");
    response.headers.set("Cache-Control", PRIVATE_NO_STORE_CACHE_CONTROL);
    return response;
  }
}
