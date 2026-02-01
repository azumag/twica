import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";

export async function POST(request: NextRequest) {
  // Content-Type validation - must be the first check
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) {
    return contentTypeValidation
  }

  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(rateLimitResult.limit),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(rateLimitResult.reset),
        },
      }
    );
  }

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const {
      streamerId,
      channelPointRewardId,
      channelPointRewardName,
      // ガチャ効果音設定（オプション）
      gachaSoundUrl,
      gachaSoundEnabled,
      // チャット通知設定（オプション）
      // Chat announcement settings (optional)
      chatAnnouncementEnabled,
      chatAnnouncementTemplate,
    } = body;

    // Verify ownership
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // 更新するフィールドを動的に構築
    // チャネルポイント設定と効果音設定の両方に対応
    const updateData: Record<string, unknown> = {};

    // チャネルポイント報酬設定（従来の機能）
    if (channelPointRewardId !== undefined) {
      updateData.channel_point_reward_id = channelPointRewardId;
    }
    if (channelPointRewardName !== undefined) {
      updateData.channel_point_reward_name = channelPointRewardName;
    }

    // ガチャ効果音設定
    // gachaSoundUrl: 効果音ファイルのURL（nullで削除）
    if (gachaSoundUrl !== undefined) {
      updateData.gacha_sound_url = gachaSoundUrl;
    }
    // gachaSoundEnabled: 効果音の有効/無効フラグ
    if (gachaSoundEnabled !== undefined) {
      updateData.gacha_sound_enabled = gachaSoundEnabled;
    }

    // チャット通知設定
    // Chat announcement settings
    // chatAnnouncementEnabled: チャット通知の有効/無効フラグ
    if (chatAnnouncementEnabled !== undefined) {
      updateData.chat_announcement_enabled = chatAnnouncementEnabled;
    }
    // chatAnnouncementTemplate: カスタムテンプレート（nullでデフォルト使用）
    if (chatAnnouncementTemplate !== undefined) {
      updateData.chat_announcement_template = chatAnnouncementTemplate;
    }

    // 更新するフィールドがない場合はエラー
    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("streamers")
      .update(updateData)
      .eq("id", streamerId);

    if (error) {
      return handleDatabaseError(error, "Streamer Settings API: PUT");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Streamer Settings API: General");
  }
}
