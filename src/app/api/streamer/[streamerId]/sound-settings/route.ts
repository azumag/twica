import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { withRetry } from "@/lib/supabase/retry";
import { handleApiError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { legacySoundToRules, normalizeGachaSoundRules } from "@/lib/gacha-sound-rules";
// #663: 読み取り専用の pg 直結経路。
// getDb() は withDbRetry の queryFn 内で呼ぶ規約（src/lib/db/retry.ts 参照）。
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { isPgMissingColumnError } from "@/lib/db/errors";
import { streamers as streamersTable } from "@/lib/db/schema";

interface RouteParams {
  params: Promise<{ streamerId: string }>;
}

interface SoundSettingsRow {
  gacha_sound_url: string | null;
  gacha_sound_enabled: boolean | null;
  gacha_sound_rules: unknown;
}

/**
 * GET (sound-settings) の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - 主 SELECT は gacha_sound_url, gacha_sound_enabled, gacha_sound_rules の3列。
 *   .maybeSingle() は id が streamers の PRIMARY KEY のため
 *   LIMIT 1 + rows[0] ?? null が同じ外部挙動。
 * - gacha_sound_rules は migration 00066 で追加された比較的新しい列のため、
 *   既存実装はローリングデプロイ窓（列未反映）を PGRST204 / "gacha_sound_rules"
 *   文言でフォールバック検知している。pg 直結では列欠落は SQLSTATE 42703 として
 *   throw されるため isPgMissingColumnError で判定する（dashboard-data.ts の
 *   getCollectionCompletionsPg と同じ方針）。gacha_sound_url / gacha_sound_enabled
 *   は migration 00007 由来の旧列のため、このクエリで 42703 が起きるとすれば
 *   実質的に gacha_sound_rules 起因と考えて良い。
 * - フォールバック SELECT が成功した場合は既存実装と同じく gacha_sound_rules: []
 *   を補完する。
 * - フォールバックも含めて失敗した場合は throw し、呼び出し元（GET ハンドラ）で
 *   既存実装と同じ「ログ + soundUrl: null, soundEnabled: false の 200 応答」に
 *   フェイルセーフする。
 *
 * 読み取り専用のため両 SELECT とも冪等（idempotent: true）としてリトライを
 * opt-in する。
 */
async function getStreamerSoundSettingsPg(streamerId: string): Promise<SoundSettingsRow | null> {
  try {
    const rows = await withDbRetry(
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
      { idempotent: true }
    );
    return rows[0] ?? null;
  } catch (error) {
    if (!isPgMissingColumnError(error)) {
      throw error;
    }

    const legacyRows = await withDbRetry(
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
      { idempotent: true }
    );
    const legacy = legacyRows[0] ?? null;
    return legacy ? { ...legacy, gacha_sound_rules: [] } : null;
  }
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
        { status: 400 }
      );
    }

    // #663: 読み取り専用のため isPgReadEnabled() で分岐。フラグ未設定時
    // （既定 'postgrest'）は下の既存 supabase-js 実装が従来どおり動く。
    if (isPgReadEnabled()) {
      let streamer: SoundSettingsRow | null;
      try {
        streamer = await getStreamerSoundSettingsPg(streamerId);
      } catch (pgError) {
        // 既存実装と同じフェイルセーフ（ログ + 効果音無効応答の200）
        logger.warn("Streamer Sound Settings API: falling back to disabled sound settings", {
          streamerId,
          error: pgError instanceof Error ? pgError.message : String(pgError),
        });
        return NextResponse.json({
          soundUrl: null,
          soundEnabled: false,
        });
      }

      if (!streamer) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.STREAMER_NOT_FOUND },
          { status: 404 }
        );
      }

      const soundRules = normalizeGachaSoundRules(streamer.gacha_sound_rules);
      const legacyRules = legacySoundToRules(
        streamer.gacha_sound_url,
        streamer.gacha_sound_enabled ?? true,
      );

      return NextResponse.json({
        soundUrl: streamer.gacha_sound_url,
        soundEnabled: streamer.gacha_sound_enabled ?? true, // デフォルトはtrue
        soundRules: soundRules.length > 0 ? soundRules : legacyRules,
      });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // 配信者の効果音設定のみを取得
    // パブリックエンドポイントなので必要最小限の情報のみ返す
    // 502 一時障害に対するリトライ (Issue #325)
    const soundSettingsResult = await withRetry(
      () => supabaseAdmin
        .from("streamers")
        .select("gacha_sound_url, gacha_sound_enabled, gacha_sound_rules")
        .eq("id", streamerId)
        .maybeSingle(),
      'getSoundSettings',
    );
    let streamer = soundSettingsResult.data;
    let error = soundSettingsResult.error;
    const { status } = soundSettingsResult;

    if (error && (error.code === "PGRST204" || error.message.includes("gacha_sound_rules"))) {
      const fallbackResult = await withRetry(
        () => supabaseAdmin
          .from("streamers")
          .select("gacha_sound_url, gacha_sound_enabled")
          .eq("id", streamerId)
          .maybeSingle(),
        "getLegacySoundSettings",
      );
      streamer = fallbackResult.data ? { ...fallbackResult.data, gacha_sound_rules: [] } : fallbackResult.data;
      error = fallbackResult.error;
    }

    if (error) {
      logger.warn("Streamer Sound Settings API: falling back to disabled sound settings", {
        streamerId,
        status,
        error: error.message,
      });
      return NextResponse.json({
        soundUrl: null,
        soundEnabled: false,
      });
    }

    if (!streamer) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_NOT_FOUND },
        { status: 404 }
      );
    }

    const soundRules = normalizeGachaSoundRules(streamer.gacha_sound_rules);
    const legacyRules = legacySoundToRules(
      streamer.gacha_sound_url,
      streamer.gacha_sound_enabled ?? true,
    );

    // 効果音設定を返す
    return NextResponse.json({
      soundUrl: streamer.gacha_sound_url,
      soundEnabled: streamer.gacha_sound_enabled ?? true, // デフォルトはtrue
      soundRules: soundRules.length > 0 ? soundRules : legacyRules,
    });
  } catch (error) {
    return handleApiError(error, "Streamer Sound Settings API");
  }
}
