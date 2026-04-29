import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";

function validateRarityWeightsInput(value: unknown): value is Record<string, number> | null {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  for (const rate of Object.values(value)) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return false;
    }
  }

  return true;
}

function hasValidRarityWeightsTotal(value: Record<string, number> | null): boolean {
  if (value === null) {
    return true;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return true;
  }

  const total = entries.reduce((sum, [, rate]) => sum + rate, 0);
  return Math.abs(total - 100) <= 0.001;
}

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
      // レアリティ別自動確率設定（オプション）
      rarityWeights,
      // 未所持カード表示設定（オプション、Issue #395）
      // Unowned-card visibility settings (optional, Issue #395)
      showUnownedCards,
      showUnownedCardDetails,
    } = body;

    if (rarityWeights !== undefined && !validateRarityWeightsInput(rarityWeights)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    if (rarityWeights !== undefined && !hasValidRarityWeightsTotal(rarityWeights)) {
      return NextResponse.json({ error: "Rarity weights total must be 100%" }, { status: 400 });
    }

    // 視聴者向け未所持カード表示の boolean 検証
    // Booleans are validated strictly to avoid silent coercion of arbitrary inputs
    if (showUnownedCards !== undefined && typeof showUnownedCards !== "boolean") {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    if (showUnownedCardDetails !== undefined && typeof showUnownedCardDetails !== "boolean") {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

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

    // rarityWeights: レアリティ別目標確率（nullで自動モード無効）
    if (rarityWeights !== undefined) {
      updateData.rarity_weights = rarityWeights;
    }

    // 未所持カードの視聴者向け表示設定
    // Unowned-card visibility settings for the viewer-facing collection page
    if (showUnownedCards !== undefined) {
      updateData.show_unowned_cards = showUnownedCards;
    }
    if (showUnownedCardDetails !== undefined) {
      updateData.show_unowned_card_details = showUnownedCardDetails;
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

    // 再計算はベストエフォート: 主操作（weights保存）は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    if (rarityWeights !== undefined) {
      try {
        recalculatedCards = await recalculateIfAutoMode(
          supabaseAdmin,
          streamerId,
          rarityWeights
        );
      } catch (recalculationError) {
        logger.error("Streamer Settings API: Recalculation failed after weight save", recalculationError);
      }
    }

    return NextResponse.json({ success: true, recalculatedCards });
  } catch (error) {
    return handleApiError(error, "Streamer Settings API: General");
  }
}
