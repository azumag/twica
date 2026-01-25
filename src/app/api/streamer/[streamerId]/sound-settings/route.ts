import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";

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
    const { data: streamer, error } = await supabaseAdmin
      .from("streamers")
      .select("gacha_sound_url, gacha_sound_enabled")
      .eq("id", streamerId)
      .single();

    if (error) {
      return handleDatabaseError(error, "Streamer Sound Settings API");
    }

    if (!streamer) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_NOT_FOUND },
        { status: 404 }
      );
    }

    // 効果音設定を返す
    return NextResponse.json({
      soundUrl: streamer.gacha_sound_url,
      soundEnabled: streamer.gacha_sound_enabled ?? true, // デフォルトはtrue
    });
  } catch (error) {
    return handleApiError(error, "Streamer Sound Settings API");
  }
}
