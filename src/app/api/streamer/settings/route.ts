import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  ERROR_MESSAGES,
  RARITIES,
  MAX_RARITY_KEY_LENGTH,
  MAX_CUSTOM_RARITIES,
  RARITY_CONTROL_CHAR_REGEX as CONTROL_CHAR_REGEX,
  RARITY_BIDI_OVERRIDE_REGEX as BIDI_OVERRIDE_REGEX,
} from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";


type RarityWeightsValidation =
  | { ok: true; value: Record<string, number> | null }
  | { ok: false };

/**
 * rarity_weights 入力を検証し、キーを正規化した安全なオブジェクトを返す。
 *
 * - 値: 0〜100 の有限数のみ。
 * - キー: trim + Unicode NFC 正規化後に、長さ 1〜40、制御文字/Bidi override を禁止。
 * - 正規化(trim/NFC)後にキーが重複する場合は不正入力として拒否する
 *   （重複を黙ってマージすると確率設計が意図せず変わるため）。
 */
function validateRarityWeightsInput(value: unknown): RarityWeightsValidation {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }

  const normalized: Record<string, number> = {};
  for (const [rawKey, rate] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      return { ok: false };
    }

    const key = rawKey.trim().normalize("NFC");
    if (
      key.length < 1
      || key.length > MAX_RARITY_KEY_LENGTH
      || CONTROL_CHAR_REGEX.test(key)
      || BIDI_OVERRIDE_REGEX.test(key)
    ) {
      return { ok: false };
    }

    // trim/NFC 後に衝突するキーは黙ってマージせず拒否する
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      return { ok: false };
    }
    normalized[key] = rate;
  }

  return { ok: true, value: normalized };
}

// デフォルトレアリティの value 集合。カスタム一覧へ重複登録させないために使用。
const DEFAULT_RARITY_VALUES = new Set<string>(RARITIES.map((r) => r.value));

type CustomRaritiesValidation =
  | { ok: true; value: string[] }
  | { ok: false };

/**
 * customRarities 入力を検証し、正規化済みの文字列配列を返す。
 *
 * rarity_weights のキー検証と同じ規則を適用する:
 * - 配列であること（要素は文字列のみ）。
 * - 各要素は trim + Unicode NFC 正規化後、長さ 1〜40。
 * - 制御文字 / Bidi override を禁止。
 * - 正規化後にデフォルトレアリティと一致するものは拒否
 *   （デフォルトは常に選択可能なため、カスタム一覧に持たせると二重表示になる）。
 * - 正規化後に重複するものは拒否（黙ってマージするとUI表示が崩れるため）。
 * - 件数上限は MAX_CUSTOM_RARITIES。
 */
function validateCustomRaritiesInput(value: unknown): CustomRaritiesValidation {
  if (!Array.isArray(value)) {
    return { ok: false };
  }
  if (value.length > MAX_CUSTOM_RARITIES) {
    return { ok: false };
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      return { ok: false };
    }
    const key = raw.trim().normalize("NFC");
    if (
      key.length < 1
      || key.length > MAX_RARITY_KEY_LENGTH
      || CONTROL_CHAR_REGEX.test(key)
      || BIDI_OVERRIDE_REGEX.test(key)
      || DEFAULT_RARITY_VALUES.has(key)
      || seen.has(key)
    ) {
      return { ok: false };
    }
    seen.add(key);
    normalized.push(key);
  }

  return { ok: true, value: normalized };
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
      chatAnnouncementMultiTemplate,
      chatAnnouncementMultiShowCards,
      // レアリティ別自動確率設定（オプション）
      rarityWeights,
      // カスタムレアリティ名の一覧（オプション、ドロップ率設定とは独立）
      // Custom rarity name catalog (optional, decoupled from drop-rate settings)
      customRarities,
      // 未所持カード表示設定（オプション、Issue #395）
      // Unowned-card visibility settings (optional, Issue #395)
      showUnownedCards,
      showUnownedCardDetails,
      // BOTアカウント連携解除（オプション）
      // Disconnect optional BOT account used for chat announcements
      disconnectBot,
    } = body;

    // 検証成功時はキーを正規化(trim/NFC)した値を以降の保存・再計算で使用する。
    let normalizedRarityWeights: Record<string, number> | null | undefined;
    if (rarityWeights !== undefined) {
      const validation = validateRarityWeightsInput(rarityWeights);
      if (!validation.ok) {
        return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
      }
      normalizedRarityWeights = validation.value;

      if (!hasValidRarityWeightsTotal(normalizedRarityWeights)) {
        return NextResponse.json({ error: "Rarity weights total must be 100%" }, { status: 400 });
      }
    }

    // customRarities はレアリティ名の一覧のみを保持し、ドロップ率には影響しない。
    // そのため再計算は行わず、独立した列にそのまま保存する。
    let normalizedCustomRarities: string[] | undefined;
    if (customRarities !== undefined) {
      const validation = validateCustomRaritiesInput(customRarities);
      if (!validation.ok) {
        return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
      }
      normalizedCustomRarities = validation.value;
    }

    // 視聴者向け未所持カード表示の boolean 検証
    // Booleans are validated strictly to avoid silent coercion of arbitrary inputs
    if (showUnownedCards !== undefined && typeof showUnownedCards !== "boolean") {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    if (showUnownedCardDetails !== undefined && typeof showUnownedCardDetails !== "boolean") {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    if (disconnectBot !== undefined && typeof disconnectBot !== "boolean") {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    if (
      chatAnnouncementMultiShowCards !== undefined
      && typeof chatAnnouncementMultiShowCards !== "boolean"
    ) {
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
    if (chatAnnouncementMultiTemplate !== undefined) {
      updateData.chat_announcement_multi_template = chatAnnouncementMultiTemplate;
    }
    if (chatAnnouncementMultiShowCards !== undefined) {
      updateData.chat_announcement_multi_show_cards = chatAnnouncementMultiShowCards;
    }

    // rarityWeights: レアリティ別目標確率（nullで自動モード無効）
    if (rarityWeights !== undefined) {
      updateData.rarity_weights = normalizedRarityWeights;
    }

    // カスタムレアリティ名（ドロップ率の再計算は不要）
    if (customRarities !== undefined) {
      updateData.custom_rarities = normalizedCustomRarities;
    }

    // 未所持カードの視聴者向け表示設定
    // Unowned-card visibility settings for the viewer-facing collection page
    if (showUnownedCards !== undefined) {
      updateData.show_unowned_cards = showUnownedCards;
    }
    if (showUnownedCardDetails !== undefined) {
      updateData.show_unowned_card_details = showUnownedCardDetails;
    }

    let botDisconnected = false;
    if (disconnectBot === true) {
      const { error: senderSettingsError } = await supabaseAdmin
        .from("streamer_chat_sender_settings")
        .upsert({
          streamer_id: streamerId,
          sender_mode: "streamer",
          custom_bot_account_id: null,
        });

      if (senderSettingsError) {
        return handleDatabaseError(senderSettingsError, "Streamer Settings API: Disconnect BOT sender settings");
      }

      const { error: botDeleteError } = await supabaseAdmin
        .from("twitch_bot_accounts")
        .delete()
        .eq("streamer_id", streamerId)
        .eq("owner_type", "streamer");

      if (botDeleteError) {
        return handleDatabaseError(botDeleteError, "Streamer Settings API: Disconnect BOT account");
      }

      botDisconnected = true;
    }

    // 更新するフィールドがない場合はエラー
    if (Object.keys(updateData).length === 0 && !botDisconnected) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    if (Object.keys(updateData).length > 0) {
      const { error } = await supabaseAdmin
        .from("streamers")
        .update(updateData)
        .eq("id", streamerId);

      if (error) {
        return handleDatabaseError(error, "Streamer Settings API: PUT");
      }
    }

    // 再計算はベストエフォート: 主操作（weights保存）は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    if (rarityWeights !== undefined) {
      try {
        recalculatedCards = await recalculateIfAutoMode(
          supabaseAdmin,
          streamerId,
          normalizedRarityWeights
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
