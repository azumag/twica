import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { withRetry } from "@/lib/supabase/retry";
import { handleApiError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { legacySoundToRules, normalizeGachaSoundRules } from "@/lib/gacha-sound-rules";

interface RouteParams {
  params: Promise<{ streamerId: string }>;
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
