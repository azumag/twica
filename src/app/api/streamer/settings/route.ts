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
  MAX_PACK_RARITY_WEIGHTS_ENTRIES,
  RARITY_CONTROL_CHAR_REGEX as CONTROL_CHAR_REGEX,
  RARITY_BIDI_OVERRIDE_REGEX as BIDI_OVERRIDE_REGEX,
} from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
import {
  resolveCollectionNameField,
  validateCardPackNamesInput,
  validatePackName,
  isRegisteredOrUnchanged,
  DEFAULT_PACK_SENTINEL,
} from "@/lib/validation/collection-name";
import {
  checkCollectionHasActiveCards,
  isMissingCollectionNameColumn,
  isMissingCardPackNamesColumnError,
  isMissingDefaultCardPackNameColumnError,
  isMissingRarityWeightsScopeColumnError,
  isMissingPackRarityWeightsColumnError,
} from "@/lib/collections/collection-existence";
import { isNewCardPackNameAdditionGated } from "@/lib/plan-gate";
import { normalizeGachaSoundRules } from "@/lib/gacha-sound-rules";


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

type PackRarityWeightsValidation =
  | { ok: true; value: Record<string, Record<string, number>> | null }
  | { ok: false };

/**
 * Issue #578(#576 フェーズ1): pack_rarity_weights 入力を検証する。
 *
 * - `null` は「全エントリをクリア」として常に許可する。
 * - オブジェクト以外(配列含む)・51件超は拒否する（DB の
 *   check_pack_rarity_weights_values と同じ上限。50パック + __default__）。
 * - 各キーは DEFAULT_PACK_SENTINEL か、`catalog`(実効パックカタログ)に
 *   登録済みの名前でなければ拒否する。
 * - 各値は validateRarityWeightsInput でキー/値の形式検証を行った上で、
 *   空オブジェクトを明示的に拒否する（グローバルへの継承は「キーを
 *   送らない」ことで表現する規約のため、空オブジェクトでの継承指定は
 *   曖昧で許可しない）。さらに hasValidRarityWeightsTotal で合計100%を要求する
 *   （各パックの実効分布は完結している必要がある）。
 *
 * 実効カタログ(catalog)は呼び出し側が決定する: 同一リクエストに
 * cardPackNames が含まれていればその新カタログ、なければ DB 上の現在の
 * card_pack_names を渡す。
 */
function validatePackRarityWeightsInput(
  value: unknown,
  catalog: string[]
): PackRarityWeightsValidation {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PACK_RARITY_WEIGHTS_ENTRIES) {
    return { ok: false };
  }

  const normalized: Record<string, Record<string, number>> = {};
  for (const [key, entryValue] of entries) {
    if (key !== DEFAULT_PACK_SENTINEL && !catalog.includes(key)) {
      return { ok: false };
    }

    const validation = validateRarityWeightsInput(entryValue);
    if (!validation.ok || validation.value === null) {
      return { ok: false };
    }

    // 空オブジェクトはグローバル継承の表現として認めない（継承したい場合は
    // キー自体を省略する規約のため、曖昧な入力として拒否する）。
    if (Object.keys(validation.value).length === 0) {
      return { ok: false };
    }

    if (!hasValidRarityWeightsTotal(validation.value)) {
      return { ok: false };
    }

    normalized[key] = validation.value;
  }

  return { ok: true, value: normalized };
}

/**
 * Issue #578: cardPackNames の保存に伴い、最終カタログに存在しなくなった
 * キーを pack_rarity_weights から取り除く。__default__ は実パックカタログの
 * メンバーではない（常に存在する疑似パック）ため、常に保持する。
 */
function prunePackRarityWeights(
  value: Record<string, Record<string, number>>,
  finalCatalog: string[]
): Record<string, Record<string, number>> {
  const pruned: Record<string, Record<string, number>> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (key === DEFAULT_PACK_SENTINEL || finalCatalog.includes(key)) {
      pruned[key] = entryValue;
    }
  }
  return pruned;
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
      // メイン報酬に紐付くカードパック名（Issue #393）は body から直接
      // resolveCollectionNameField で読むため、ここでは分割代入しない。
      // ガチャ効果音設定（オプション）
      gachaSoundUrl,
      gachaSoundEnabled,
      gachaSoundRules,
      // チャット通知設定（オプション）
      // Chat announcement settings (optional)
      chatAnnouncementEnabled,
      chatAnnouncementTemplate,
      chatAnnouncementMultiTemplate,
      chatAnnouncementMultiShowCards,
      // レアリティ別自動確率設定（オプション）
      rarityWeights,
      // レアリティ重みのスコープ（オプション、Issue #578）: 'global'(全パック共通)
      // か 'per_pack'(パック別、packRarityWeights を優先)か。実効重みの計算
      // (パック別ドロップ率反映)は抽選時に行う(#576 フェーズ2)ため、ここでの
      // 保存では drop_rate の再計算は一切トリガーしない。
      // Rarity-weight scope (optional, Issue #578): 'global' (shared across
      // all packs) or 'per_pack' (packRarityWeights takes precedence).
      // Effective per-pack weights are computed at DRAW TIME (#576 Phase 2),
      // so saving this field never triggers a drop_rate recalculation.
      rarityWeightsScope,
      // パック別レアリティ重みの上書きマップ（オプション、Issue #578）。
      // null で全クリア。キーはパック名または __default__。
      // Per-pack rarity-weight override map (optional, Issue #578). null
      // clears all entries. Keys are pack names or __default__.
      packRarityWeights,
      // カスタムレアリティ名の一覧（オプション、ドロップ率設定とは独立）
      // Custom rarity name catalog (optional, decoupled from drop-rate settings)
      customRarities,
      // 事前登録カードパック名の一覧（オプション、カード/報酬紐付けとは独立）
      // Pre-defined card pack name catalog (optional, decoupled from card/reward bindings)
      cardPackNames,
      // 「デフォルト」(未分類)パックの表示名オーバーライド（オプション、Issue #554）。
      // null でリセット（汎用ラベル表示に戻す）。カタログ(card_pack_names)への
      // 登録・重複チェックは不要 — 表示専用の独立した文字列のため。
      // Display-name override for the "default" (unclassified) pack (optional,
      // Issue #554). null resets it back to the generic label. No catalog
      // membership/uniqueness check needed — this is a standalone display string.
      defaultCardPackName,
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

    // rarityWeightsScope: 'global' | 'per_pack' の2値のみ許可（Issue #578）。
    if (
      rarityWeightsScope !== undefined
      && rarityWeightsScope !== "global"
      && rarityWeightsScope !== "per_pack"
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
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

    // cardPackNames は事前登録カードパック名の一覧のみを保持する（Issue #393再設計）。
    let normalizedCardPackNames: string[] | undefined;
    if (cardPackNames !== undefined) {
      const validation = validateCardPackNamesInput(cardPackNames);
      if (!validation.ok) {
        return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
      }
      normalizedCardPackNames = validation.value;
    }

    // defaultCardPackName: 同じルール(validatePackName)で検証するが、null は
    // 「リセット」として常に許可する（カード名一覧と違い、単一の任意項目のため
    // "" trim 結果が空になるケースは validatePackName が弾く。プランゲートなし
    // — 既存パック名の管理操作と同様、Issue #269 のゲート対象は新規登録のみ）。
    let normalizedDefaultCardPackName: string | null | undefined;
    if (defaultCardPackName !== undefined) {
      if (defaultCardPackName === null) {
        normalizedDefaultCardPackName = null;
      } else {
        const validation = validatePackName(defaultCardPackName);
        if (!validation.ok) {
          return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
        }
        normalizedDefaultCardPackName = validation.value;
      }
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

    if (gachaSoundRules !== undefined && !Array.isArray(gachaSoundRules)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    // Issue #393: validate the main-reward pack name (null = all cards).
    const channelPointCollectionResult = resolveCollectionNameField(body, "channelPointCollectionName");
    if (!channelPointCollectionResult.ok) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    // Verify ownership
    let { data: streamer, error: streamerSelectError } = await supabaseAdmin
      .from("streamers")
      .select("id, channel_point_collection_name, card_pack_names, pack_rarity_weights")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    // Issue #578: pack_rarity_weights はこのフェーズで新規追加された列。デプロイ窓では
    // 他の列より先に(あるいは他が既に安定デプロイ済みの状態で単独で)未デプロイになり
    // うるため、既存の card_pack_names / channel_point_collection_name と同じチェイン
    // 方式で、まずこの列だけ剥がして再試行する。プルーニング(下記)に使う現在値の
    // 読み取りが目的で、未デプロイなら「保存されているエントリなし」= null 扱いにする。
    if (streamerSelectError && isMissingPackRarityWeightsColumnError(streamerSelectError)) {
      const retryResult = await supabaseAdmin
        .from("streamers")
        .select("id, channel_point_collection_name, card_pack_names")
        .eq("id", streamerId)
        .eq("twitch_user_id", session.twitchUserId)
        .maybeSingle();
      streamer = retryResult.data
        ? { ...retryResult.data, pack_rarity_weights: null as Record<string, Record<string, number>> | null }
        : null;
      streamerSelectError = retryResult.error;
    }

    // Issue #393再設計 / #269: このownership確認SELECTは channel_point_collection_name
    // と card_pack_names の現在値を読むために2列を含む。デプロイ窓ではどちらか
    // (または両方)が未デプロイになりうるため、都度1列だけ剥がして再試行する
    // (既存の card_number → collection_name と同じチェイン方式)。どちらの列も
    // 未デプロイの通常設定保存を403にしないための安全策(#269自己レビューで
    // 発見・修正した回帰の再発防止)。
    if (streamerSelectError && isMissingCardPackNamesColumnError(streamerSelectError)) {
      const retryResult = await supabaseAdmin
        .from("streamers")
        .select("id, channel_point_collection_name")
        .eq("id", streamerId)
        .eq("twitch_user_id", session.twitchUserId)
        .maybeSingle();
      streamer = retryResult.data
        ? {
            ...retryResult.data,
            card_pack_names: [] as string[],
            pack_rarity_weights: null as Record<string, Record<string, number>> | null,
          }
        : null;
      streamerSelectError = retryResult.error;
    }

    if (streamerSelectError && isMissingCollectionNameColumn(streamerSelectError)) {
      const retryResult = await supabaseAdmin
        .from("streamers")
        .select("id")
        .eq("id", streamerId)
        .eq("twitch_user_id", session.twitchUserId)
        .maybeSingle();
      streamer = retryResult.data
        ? {
            ...retryResult.data,
            channel_point_collection_name: null,
            card_pack_names: [] as string[],
            pack_rarity_weights: null as Record<string, Record<string, number>> | null,
          }
        : null;
      streamerSelectError = retryResult.error;
    }

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const currentCardPackNames: string[] = Array.isArray(streamer.card_pack_names)
      ? streamer.card_pack_names
      : [];

    // pack_rarity_weights は object 前提の列（配列/非objectは不正データとして
    // 無視しnullにフォールバック — DBのCHECK制約により通常発生しない防御的処理）。
    const currentPackRarityWeights: Record<string, Record<string, number>> | null =
      streamer.pack_rarity_weights
      && typeof streamer.pack_rarity_weights === "object"
      && !Array.isArray(streamer.pack_rarity_weights)
        ? (streamer.pack_rarity_weights as Record<string, Record<string, number>>)
        : null;

    // Issue #578(#576 フェーズ1): packRarityWeights のキーは、同一リクエストで
    // cardPackNames も送られていればその新カタログ、そうでなければ DB 上の
    // 現在の card_pack_names を実効カタログとして検証する。
    const effectivePackCatalogForRarityWeights: string[] =
      normalizedCardPackNames !== undefined ? normalizedCardPackNames : currentCardPackNames;

    let normalizedPackRarityWeights: Record<string, Record<string, number>> | null | undefined;
    if (packRarityWeights !== undefined) {
      const validation = validatePackRarityWeightsInput(
        packRarityWeights,
        effectivePackCatalogForRarityWeights
      );
      if (!validation.ok) {
        return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
      }
      normalizedPackRarityWeights = validation.value;
    }

    // Issue #269再設計: 「新しい登録」= card_pack_names一覧への新規追加のみを
    // ゲートする。カード/報酬への既存パックの紐付け(選択)はもうゲート対象外。
    let persistedCardPackNames: string[] = currentCardPackNames;
    let cardPackNamesPremiumRequired = false;
    if (normalizedCardPackNames !== undefined) {
      const addedNames = normalizedCardPackNames.filter((name) => !currentCardPackNames.includes(name));
      cardPackNamesPremiumRequired = await isNewCardPackNameAdditionGated(session.twitchUserId, addedNames);
      persistedCardPackNames = cardPackNamesPremiumRequired
        ? normalizedCardPackNames.filter((name) => currentCardPackNames.includes(name))
        : normalizedCardPackNames;
    }

    // Issue #578: cardPackNames の保存に伴い、最終カタログ(persistedCardPackNames、
    // ゲート適用後)に存在しなくなったキーを pack_rarity_weights から取り除く
    // (__default__ は常に保持)。packRarityWeights が同一リクエストで指定されて
    // いればそれを、されていなければ DB の現在値(currentPackRarityWeights)を
    // プルーニング対象の基準にする — 「cardPackNamesだけ送っても機能する」
    // 仕様のため、packRarityWeights 未指定でも DB 上の値を読み直して整合させる。
    let packRarityWeightsToPersist: Record<string, Record<string, number>> | null | undefined =
      normalizedPackRarityWeights;

    if (normalizedCardPackNames !== undefined) {
      const pruneBasis = packRarityWeightsToPersist !== undefined
        ? packRarityWeightsToPersist
        : currentPackRarityWeights;
      if (pruneBasis !== null) {
        packRarityWeightsToPersist = prunePackRarityWeights(pruneBasis, persistedCardPackNames);
      }
      // pruneBasis が null かつ packRarityWeightsToPersist が未指定の場合、
      // プルーニングすべき既存エントリが無いため何もしない(undefinedのまま)。
    }

    // Issue #393再設計: メイン報酬のパック紐付けは、null化・現在値の再送信は
    // 常に許可し、新しい値は「この保存で確定した persistedCardPackNames」に
    // 登録済みであることを要求する(#5参照: cardPackNamesのゲート適用後の
    // リストに対して判定する。カード削除等で一覧から消えたパックへの既存
    // 紐付けは、値を変えない限り常に許可=孤立参照でも壊れない)。
    //
    // Issue #555: DEFAULT_PACK_SENTINEL(「デフォルトパックのみ」選択)は
    // 予約値であり、そもそも card_pack_names に登録できない
    // (isReservedCollectionName)。そのため常に非登録扱いとなり、通常の
    // membership検証にかけると誰も選べなくなってしまう。すべてのストリーマー
    // が持つ疑似パック(=未分類カード)として、membership検証自体を常に
    // スキップして受理する(存在検証は下のcheckCollectionHasActiveCardsで
    // 別途行う)。
    if (
      channelPointCollectionResult.value !== undefined &&
      channelPointCollectionResult.value !== DEFAULT_PACK_SENTINEL &&
      !isRegisteredOrUnchanged(
        channelPointCollectionResult.value,
        streamer.channel_point_collection_name,
        persistedCardPackNames
      )
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
    }

    // Issue #393: reject binding the main reward to a pack with no active cards,
    // which would always resolve to an empty draw pool at redemption time.
    // 値が実際に変わる場合のみチェックする(#1: 孤立参照の再送信では走らせない)。
    if (
      typeof channelPointCollectionResult.value === "string" &&
      channelPointCollectionResult.value !== streamer.channel_point_collection_name
    ) {
      const existence = await checkCollectionHasActiveCards(
        supabaseAdmin,
        streamer.id,
        channelPointCollectionResult.value
      );
      if (existence === "absent") {
        return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_FOUND }, { status: 400 });
      }
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
    // Issue #393: persist the main-reward pack binding (null clears it = all cards).
    // membership検証(上記)を通っているため、ここでは無条件に保存する。
    if (channelPointCollectionResult.value !== undefined) {
      updateData.channel_point_collection_name = channelPointCollectionResult.value;
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
    if (gachaSoundRules !== undefined) {
      const rules = normalizeGachaSoundRules(gachaSoundRules);
      updateData.gacha_sound_rules = rules;
      const fallbackRule = rules.find((rule) => rule.enabled && rule.targetType === "all") ?? rules.find((rule) => rule.enabled);
      updateData.gacha_sound_url = fallbackRule?.url ?? null;
      updateData.gacha_sound_enabled = Boolean(fallbackRule);
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

    // Issue #578(#576 フェーズ1): rarity_weights_scope / pack_rarity_weights。
    // 実効重みは抽選時計算(#576 設計)のため、これらの保存では drop_rate の
    // 再計算(recalculateIfAutoMode)は一切トリガーしない(下記の再計算呼び出しは
    // rarityWeights !== undefined のみを条件としており、この2フィールドは対象外)。
    if (rarityWeightsScope !== undefined) {
      updateData.rarity_weights_scope = rarityWeightsScope;
    }
    if (packRarityWeightsToPersist !== undefined) {
      updateData.pack_rarity_weights = packRarityWeightsToPersist;
    }

    // カスタムレアリティ名（ドロップ率の再計算は不要）
    if (customRarities !== undefined) {
      updateData.custom_rarities = normalizedCustomRarities;
    }

    // 事前登録カードパック名（Issue #393再設計）。ゲートで一部却下されていても
    // persistedCardPackNames(=保存してよい範囲)を無条件に保存する。
    if (normalizedCardPackNames !== undefined) {
      updateData.card_pack_names = persistedCardPackNames;
    }

    // 「デフォルト」パックの表示名オーバーライド（Issue #554）。
    if (normalizedDefaultCardPackName !== undefined) {
      updateData.default_card_pack_name = normalizedDefaultCardPackName;
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
    // (cardPackNames は指定されていれば必ず updateData に入るため、
    // このガードで空になるケースはもう channelPointCollectionName 由来では
    // 発生しない=特別扱いは不要)。
    if (Object.keys(updateData).length === 0 && !botDisconnected) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    // 自己レビューで発見: 書き込み時点でcard_pack_names列が無く剥がして
    // リトライした場合、DBには実際には保存されていない。にもかかわらず
    // レスポンスで persistedCardPackNames(要求どおり保存できた前提の値)を
    // 返すと、クライアントに「保存できた」と偽って伝えてしまう。このフラグで
    // 実際に書き込めたかどうかを追跡し、レスポンスの真正性を保証する。
    let cardPackNamesWriteSkipped = false;
    // Issue #554: 同じ理由(デプロイ窓)で default_card_pack_name 列がまだ
    // 無い可能性があるため、card_pack_names と同じ skip-and-flag パターンを踏襲する。
    let defaultCardPackNameWriteSkipped = false;
    // Issue #578: rarity_weights_scope / pack_rarity_weights も同じ理由(デプロイ窓)で
    // skip-and-flag パターンを踏襲する。
    let rarityWeightsScopeWriteSkipped = false;
    let packRarityWeightsWriteSkipped = false;

    if (Object.keys(updateData).length > 0) {
      let { error } = await supabaseAdmin
        .from("streamers")
        .update(updateData)
        .eq("id", streamerId);

      // Issue #578: このフェーズで新規追加された列を最初に剥がす(他の既存列より
      // 未デプロイである可能性が高いため)。
      if (error && isMissingRarityWeightsScopeColumnError(error) && "rarity_weights_scope" in updateData) {
        delete updateData.rarity_weights_scope;
        rarityWeightsScopeWriteSkipped = true;
        if (Object.keys(updateData).length > 0) {
          const retryResult = await supabaseAdmin
            .from("streamers")
            .update(updateData)
            .eq("id", streamerId);
          error = retryResult.error;
        } else {
          error = null;
        }
      }

      if (error && isMissingPackRarityWeightsColumnError(error) && "pack_rarity_weights" in updateData) {
        delete updateData.pack_rarity_weights;
        packRarityWeightsWriteSkipped = true;
        if (Object.keys(updateData).length > 0) {
          const retryResult = await supabaseAdmin
            .from("streamers")
            .update(updateData)
            .eq("id", streamerId);
          error = retryResult.error;
        } else {
          error = null;
        }
      }

      // Issue #393再設計: 書き込み時点で card_pack_names / channel_point_collection_name
      // のどちらか(または両方)が未デプロイの可能性があるため、都度1列だけ剥がして再試行する。
      if (error && isMissingCardPackNamesColumnError(error) && "card_pack_names" in updateData) {
        delete updateData.card_pack_names;
        cardPackNamesWriteSkipped = true;
        if (Object.keys(updateData).length > 0) {
          const retryResult = await supabaseAdmin
            .from("streamers")
            .update(updateData)
            .eq("id", streamerId);
          error = retryResult.error;
        } else {
          error = null;
        }
      }

      if (error && isMissingDefaultCardPackNameColumnError(error) && "default_card_pack_name" in updateData) {
        delete updateData.default_card_pack_name;
        defaultCardPackNameWriteSkipped = true;
        if (Object.keys(updateData).length > 0) {
          const retryResult = await supabaseAdmin
            .from("streamers")
            .update(updateData)
            .eq("id", streamerId);
          error = retryResult.error;
        } else {
          error = null;
        }
      }

      if (error && isMissingCollectionNameColumn(error) && "channel_point_collection_name" in updateData) {
        delete updateData.channel_point_collection_name;
        if (Object.keys(updateData).length > 0) {
          const retryResult = await supabaseAdmin
            .from("streamers")
            .update(updateData)
            .eq("id", streamerId);
          error = retryResult.error;
        } else {
          error = null;
        }
      }

      // Issue #176: gacha_sound_rules はこのフィーチャーで新規追加された列。
      // デプロイ窓では未デプロイの可能性があるため、列を落として旧来の
      // gacha_sound_url/gacha_sound_enabled のみで再試行する(グレースフルデグレード)。
      if (
        error &&
        gachaSoundRules !== undefined &&
        (error.code === "PGRST204" || error.message.includes("gacha_sound_rules"))
      ) {
        logger.warn("gacha_sound_rules column not available yet; saving legacy sound fallback only");
        const legacyUpdateData = { ...updateData };
        delete legacyUpdateData.gacha_sound_rules;
        const fallbackResult = await supabaseAdmin
          .from("streamers")
          .update(legacyUpdateData)
          .eq("id", streamerId);
        error = fallbackResult.error;
      }

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

    return NextResponse.json({
      success: true,
      recalculatedCards,
      // Issue #393再設計: cardPackNamesを指定した場合、実際にDBへ永続化された
      // リストを常に返す(クライアントはこれでstateを同期する)。書き込み自体が
      // デプロイ窓で見送られた場合は、保存前の currentCardPackNames を返す
      // (persistedCardPackNamesは「保存できた前提」の値であり、実態と異なる)。
      ...(normalizedCardPackNames !== undefined
        ? { cardPackNames: cardPackNamesWriteSkipped ? currentCardPackNames : persistedCardPackNames }
        : {}),
      ...(cardPackNamesPremiumRequired ? { cardPackNamesPremiumRequired: true } : {}),
      ...(cardPackNamesWriteSkipped ? { cardPackNamesSkippedDeployWindow: true } : {}),
      // Issue #554: no value is echoed back (unlike cardPackNames) because
      // there is no server-side rejection scenario for this field (no plan
      // gate, no catalog membership check) — the client's submitted value is
      // authoritative on success. Only the deploy-window skip needs a flag.
      ...(defaultCardPackNameWriteSkipped ? { defaultCardPackNameSkippedDeployWindow: true } : {}),
      // Issue #578: rarityWeightsScope はエコーバック不要(サーバ側の却下・
      // 加工シナリオが無く送信値がそのまま正)。一方 packRarityWeights は
      // **サーバ側で黙って加工されるシナリオがある**: 同一リクエストの
      // cardPackNames 追加がプレミアムゲートで却下されると、その追加パック向け
      // エントリは prune で落ちる(検証はゲート適用前の要求カタログに対して
      // 通っているため 400 にはならない)。cardPackNames と同様、確定後の
      // 永続値をエコーバックしてクライアントが state を再同期できるようにする。
      // デプロイ窓 skip 時は書き込まれていないためエコーしない(フラグで通知)。
      ...(packRarityWeightsToPersist !== undefined && !packRarityWeightsWriteSkipped
        ? { packRarityWeights: packRarityWeightsToPersist }
        : {}),
      ...(rarityWeightsScopeWriteSkipped ? { rarityWeightsScopeSkippedDeployWindow: true } : {}),
      ...(packRarityWeightsWriteSkipped ? { packRarityWeightsSkippedDeployWindow: true } : {}),
    });
  } catch (error) {
    return handleApiError(error, "Streamer Settings API: General");
  }
}
