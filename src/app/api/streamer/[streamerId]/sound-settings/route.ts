import { type NextRequest, NextResponse } from "next/server";


import { handleApiError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";
import { logger } from "@/lib/logger.server";
import { legacySoundToRules, normalizeGachaSoundRules } from "@/lib/gacha-sound-rules";
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

// #675: Workers Cache の公開GETパイロット。
// settings POST 側の Cache-Tag purge はまだ結線していないため、まずは 1 秒だけ
// edge cache し、同時リクエストの request collapsing を有効にする。長TTL化は
// tag purge と同時に行い、設定変更直後の古い値が長時間残る退行を作らない。
const SOUND_SETTINGS_CACHE_CONTROL = "public, max-age=0, s-maxage=1";
const NO_STORE_CACHE_CONTROL = "private, no-store";

interface SoundSettingsRow {
  gacha_sound_url: string | null;
  gacha_sound_enabled: boolean | null;
  gacha_sound_rules: unknown;
}

/**
 * GET の DB アクセス結果を表す判別共用体。
 * - 'ok': 取得成功（streamer が null の場合は行が存在しない = 404 対象）
 * - 'degraded': DB エラー（gacha_sound_rules 列欠落フォールバックも含めて失敗）。
 *   既存実装は取得失敗時に例外を投げず「効果音無効」の安全側デフォルトへ
 *   デグレードするため、その外部挙動をそのまま型で表現する。
 */
type SoundSettingsLookup =
  | { kind: "ok"; streamer: SoundSettingsRow | null }
  | { kind: "degraded" };

/**
 * getSoundSettings の pg 直結実装 (#663)
 *
 * - streamers を id で 1 行取得。id は PK のため LIMIT 1 + rows[0] ?? null で
 *   .maybeSingle() と同じ外部挙動。
 * - gacha_sound_rules 列欠落フォールバックは SQLSTATE 42703 と列名を同時に
 *   確認し、接続断や別列のエラーを縮退対象へ含めない。
 * - フォールバック取得も失敗した場合、または最初から gacha_sound_rules 以外の
 *   理由で失敗した場合は 'degraded' を返し、呼び出し元が既存と同じ「効果音無効」
 *   応答にフォールバックする。
 */
async function getSoundSettingsPg(streamerId: string): Promise<SoundSettingsLookup> {
  const selectFull = () =>
    withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            gacha_sound_url: streamersTable.gacha_sound_url,
            gacha_sound_enabled: streamersTable.gacha_sound_enabled,
            gacha_sound_rules: streamersTable.gacha_sound_rules,
          })
          .from(streamersTable)
          .where(eq(streamersTable.id, streamerId))
          .limit(1);
      },
      "getSoundSettings",
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );

  const selectLegacy = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            gacha_sound_url: streamersTable.gacha_sound_url,
            gacha_sound_enabled: streamersTable.gacha_sound_enabled,
          })
          .from(streamersTable)
          .where(eq(streamersTable.id, streamerId))
          .limit(1);
      },
      "getLegacySoundSettings",
      { idempotent: true },
    );

  try {
    const rows = await selectFull();
    return { kind: "ok", streamer: rows[0] ?? null };
  } catch (error) {
    if (isPgMissingNamedColumnError(error, ["gacha_sound_rules"])) {
      try {
        const rows = await selectLegacy();
        const row = rows[0] ?? null;
        return { kind: "ok", streamer: row ? { ...row, gacha_sound_rules: [] } : null };
      } catch (fallbackError) {
        logger.warn("Streamer Sound Settings API: falling back to disabled sound settings", {
          streamerId,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        return { kind: "degraded" };
      }
    }
    logger.warn("Streamer Sound Settings API: falling back to disabled sound settings", {
      streamerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "degraded" };
  }
}



async function getSoundSettings(streamerId: string): Promise<SoundSettingsLookup> {
  // #663: 読み取り専用の関数のため PlanetScale の単一接続を使用。
  return getSoundSettingsPg(streamerId);

}

/**
 * 配信者の効果音設定を取得
 * 認証不要のパブリックエンドポイント（オーバーレイから呼び出される）
 * GET /api/streamer/[streamerId]/sound-settings
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
          headers: { "Cache-Control": NO_STORE_CACHE_CONTROL },
        }
      );
    }

    const lookup = await getSoundSettings(streamerId);

    if (lookup.kind === "degraded") {
      return NextResponse.json(
        {
          soundUrl: null,
          soundEnabled: false,
        },
        { headers: { "Cache-Control": NO_STORE_CACHE_CONTROL } }
      );
    }

    const streamer = lookup.streamer;

    if (!streamer) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_NOT_FOUND },
        {
          status: 404,
          headers: { "Cache-Control": NO_STORE_CACHE_CONTROL },
        }
      );
    }

    const soundRules = normalizeGachaSoundRules(streamer.gacha_sound_rules);
    const legacyRules = legacySoundToRules(
      streamer.gacha_sound_url,
      streamer.gacha_sound_enabled ?? true,
    );

    // 効果音設定を返す。streamerId は DB の PK として取得成功した値だけがここへ
    // 到達するため、そのまま Cache-Tag のスコープキーとして使用できる。
    return NextResponse.json(
      {
        soundUrl: streamer.gacha_sound_url,
        soundEnabled: streamer.gacha_sound_enabled ?? true, // デフォルトはtrue
        soundRules: soundRules.length > 0 ? soundRules : legacyRules,
      },
      {
        headers: {
          "Cache-Control": SOUND_SETTINGS_CACHE_CONTROL,
          "Cache-Tag": `sound-settings-${streamerId}`,
        },
      }
    );
  } catch (error) {
    const response = await handleApiError(error, "Streamer Sound Settings API");
    response.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
    return response;
  }
}
