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
import {
  normalizeGachaSoundRules,
  isAllowedSoundUrl,
  legacySoundToRules,
  type GachaSoundRule,
} from "@/lib/gacha-sound-rules";
import { getUserPlan } from "@/lib/plan";
// -----------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。
// このファイルは POST 1 本の中に ~6 個の DB アクセス（所有権+現在値 SELECT、BOT
// 切断の UPSERT+DELETE、streamers の 5 段階フォールバック UPDATE）が ~350 行の
// 共有バリデーション/正規化ロジックを挟んで直列に並ぶため、DB 操作の境界ごとに
// 小さな named helper 関数へ分解し、各 helper が自分の先頭で isPgReadEnabled() /
// isPgWriteEnabled() 分岐を持つ（announcements.ts / token-manager.ts と同じ
// パターン）。POST 本体の共有バリデーション/正規化コードは完全に手を触れない。
// 既存 supabase-js 実装は 1 文字も変えず、フラグ未設定時は完全に従来どおり動く。
// pg 実装は getDb() を withDbRetry の queryFn 内で呼ぶ規約（src/lib/db/retry.ts 参照）。
// -----------------------------------------------------------------------------
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled, isPgWriteEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import {
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
} from "@/lib/db/schema";

type GenericDbError = { message?: string; code?: string; details?: string; hint?: string } | null | undefined;


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

// ---------------------------------------------------------------------------
// DB 操作 1: 所有権 + 現在値 SELECT（読み取り専用 → isPgReadEnabled）
// ---------------------------------------------------------------------------

interface StreamerForSettingsUpdate {
  id: string;
  channel_point_collection_name: string | null;
  card_pack_names: string[];
  pack_rarity_weights: Record<string, Record<string, number>> | null;
}

/**
 * getStreamerForSettingsUpdate の pg 直結実装 (#663)
 *
 * PostgREST 実装（下の getStreamerForSettingsUpdate 内の postgrest 分岐）と同じ
 * 3段階フォールバックチェイン（pack_rarity_weights → card_pack_names →
 * channel_point_collection_name の順で、未デプロイ列を1つずつ剥がして再試行）を
 * throw ベースで再現する。各段は「直前の段の結果として今どのエラーを見ているか」
 * を引き継ぐ必要があるため、currentError を明示的に持ち回る。
 *
 * いずれの判定にも合致しない・最終フォールバックまで失敗した場合は null を返す
 * （postgrest 実装が streamerSelectError の種類を問わず !streamer で 403 に
 * 倒す既存の安全側デグレードと同じ外部挙動）。
 */
async function getStreamerForSettingsUpdatePg(
  streamerId: string,
  twitchUserId: string
): Promise<StreamerForSettingsUpdate | null> {
  const ownerCondition = and(
    eq(streamersTable.id, streamerId),
    eq(streamersTable.twitch_user_id, twitchUserId)
  );

  const selectFull = () =>
    withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            channel_point_collection_name: streamersTable.channel_point_collection_name,
            card_pack_names: streamersTable.card_pack_names,
            pack_rarity_weights: streamersTable.pack_rarity_weights,
          })
          .from(streamersTable)
          .where(ownerCondition)
          .limit(1);
      },
      "getStreamerForSettingsUpdate(full)",
      { idempotent: true },
    );

  const selectWithoutPackRarityWeights = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            channel_point_collection_name: streamersTable.channel_point_collection_name,
            card_pack_names: streamersTable.card_pack_names,
          })
          .from(streamersTable)
          .where(ownerCondition)
          .limit(1);
      },
      "getStreamerForSettingsUpdate(no pack_rarity_weights)",
      { idempotent: true },
    );

  const selectWithoutCardPackNames = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            channel_point_collection_name: streamersTable.channel_point_collection_name,
          })
          .from(streamersTable)
          .where(ownerCondition)
          .limit(1);
      },
      "getStreamerForSettingsUpdate(no card_pack_names)",
      { idempotent: true },
    );

  const selectIdOnly = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(ownerCondition)
          .limit(1);
      },
      "getStreamerForSettingsUpdate(id only)",
      { idempotent: true },
    );

  try {
    const rows = await selectFull();
    return rows[0] ?? null;
  } catch (initialError) {
    let currentError: unknown = initialError;
    let row: StreamerForSettingsUpdate | null = null;
    let resolved = false;

    if (isMissingPackRarityWeightsColumnError(currentError as GenericDbError)) {
      try {
        const rows = await selectWithoutPackRarityWeights();
        row = rows[0] ? { ...rows[0], pack_rarity_weights: null } : null;
        resolved = true;
        currentError = null;
      } catch (err) {
        currentError = err;
      }
    }

    if (currentError && isMissingCardPackNamesColumnError(currentError as GenericDbError)) {
      try {
        const rows = await selectWithoutCardPackNames();
        row = rows[0] ? { ...rows[0], card_pack_names: [], pack_rarity_weights: null } : null;
        resolved = true;
        currentError = null;
      } catch (err) {
        currentError = err;
      }
    }

    if (currentError && isMissingCollectionNameColumn(currentError as GenericDbError)) {
      try {
        const rows = await selectIdOnly();
        row = rows[0]
          ? { ...rows[0], channel_point_collection_name: null, card_pack_names: [], pack_rarity_weights: null }
          : null;
        resolved = true;
        currentError = null;
      } catch (err) {
        currentError = err;
      }
    }

    if (currentError) {
      // postgrest 実装は streamerSelectError が残っていても種類を問わず
      // !streamer → 403 に倒す（明示的な handleDatabaseError は無い）。
      // 同じ外部挙動に合わせ、未処理のエラーは呼び出し元に伝播させず null で返す。
      return null;
    }

    return resolved ? row : null;
  }
}

async function getStreamerForSettingsUpdate(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  twitchUserId: string
): Promise<StreamerForSettingsUpdate | null> {
  // #663: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
  if (isPgReadEnabled()) {
    return getStreamerForSettingsUpdatePg(streamerId, twitchUserId);
  }

  // Verify ownership
  let { data: streamer, error: streamerSelectError } = await supabaseAdmin
    .from("streamers")
    .select("id, channel_point_collection_name, card_pack_names, pack_rarity_weights")
    .eq("id", streamerId)
    .eq("twitch_user_id", twitchUserId)
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
      .eq("twitch_user_id", twitchUserId)
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
      .eq("twitch_user_id", twitchUserId)
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
      .eq("twitch_user_id", twitchUserId)
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

  return (streamer as StreamerForSettingsUpdate | null) ?? null;
}

// ---------------------------------------------------------------------------
// DB 操作 2: disconnectBot ブロック（UPSERT + DELETE、書き込み → isPgWriteEnabled）
// ---------------------------------------------------------------------------

interface DisconnectBotAccountFailure {
  error: unknown;
  context: string;
}

/**
 * disconnectBotAccount の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - streamer_chat_sender_settings への upsert は streamer_id が PK
 *   （migration 00040, schema.ts 参照）のため onConflictDoUpdate(target: streamer_id)
 *   が等価。
 * - twitch_bot_accounts の DELETE は streamer_id + owner_type='streamer' の
 *   フィルタ指定 DELETE のため and(eq, eq) が等価。
 * - どちらも明示値の全置換（UPSERT は同じ固定値、DELETE はフィルタ一致行の削除）
 *   のためリトライしても最終状態は同じ = 冪等（idempotent: true）。
 */
async function disconnectBotAccountPg(streamerId: string): Promise<DisconnectBotAccountFailure | null> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .insert(streamerChatSenderSettingsTable)
          .values({
            streamer_id: streamerId,
            sender_mode: "streamer",
            custom_bot_account_id: null,
          })
          .onConflictDoUpdate({
            target: streamerChatSenderSettingsTable.streamer_id,
            set: {
              sender_mode: "streamer",
              custom_bot_account_id: null,
            },
          });
      },
      "disconnectBotAccount(upsert sender settings)",
      { idempotent: true },
    );
  } catch (error) {
    return { error, context: "Streamer Settings API: Disconnect BOT sender settings" };
  }

  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .delete(twitchBotAccountsTable)
          .where(
            and(
              eq(twitchBotAccountsTable.streamer_id, streamerId),
              eq(twitchBotAccountsTable.owner_type, "streamer")
            )
          );
      },
      "disconnectBotAccount(delete bot account)",
      { idempotent: true },
    );
  } catch (error) {
    return { error, context: "Streamer Settings API: Disconnect BOT account" };
  }

  return null;
}

async function disconnectBotAccount(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string
): Promise<DisconnectBotAccountFailure | null> {
  // #663: 書き込みのみの関数のため isPgWriteEnabled() で分岐。
  if (isPgWriteEnabled()) {
    return disconnectBotAccountPg(streamerId);
  }

  const { error: senderSettingsError } = await supabaseAdmin
    .from("streamer_chat_sender_settings")
    .upsert({
      streamer_id: streamerId,
      sender_mode: "streamer",
      custom_bot_account_id: null,
    });

  if (senderSettingsError) {
    return { error: senderSettingsError, context: "Streamer Settings API: Disconnect BOT sender settings" };
  }

  const { error: botDeleteError } = await supabaseAdmin
    .from("twitch_bot_accounts")
    .delete()
    .eq("streamer_id", streamerId)
    .eq("owner_type", "streamer");

  if (botDeleteError) {
    return { error: botDeleteError, context: "Streamer Settings API: Disconnect BOT account" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// DB 操作 3: streamers の主 UPDATE（5段階フォールバックチェイン、書き込み →
// isPgWriteEnabled）
// ---------------------------------------------------------------------------

interface ApplyStreamerSettingsUpdateResult {
  error: unknown;
  rarityWeightsScopeWriteSkipped: boolean;
  packRarityWeightsWriteSkipped: boolean;
  cardPackNamesWriteSkipped: boolean;
  defaultCardPackNameWriteSkipped: boolean;
  gachaSoundRulesWriteSkipped: boolean;
}

/**
 * gacha_sound_rules 列欠落フォールバックの判定。既存実装と同じ汎用テキスト判定
 * （code === "PGRST204" || message に "gacha_sound_rules" を含む）で、pg
 * （postgres.js）の 42703 も message 側でそのまま判定できる（新規の pg 専用
 * エラー整形ヘルパーは作らない）。
 */
function isMissingGachaSoundRulesColumnError(error: unknown): boolean {
  const err = error as GenericDbError;
  return err?.code === "PGRST204" || String(err?.message ?? "").includes("gacha_sound_rules");
}

/**
 * applyStreamerSettingsUpdate の pg 直結実装 (#663)
 *
 * PostgREST 実装（下の applyStreamerSettingsUpdatePostgrest）と同じ 5 段階
 * フォールバックチェイン + gacha_sound_rules 用の最終フォールバックを throw
 * ベースで再現する。各段の判定は「直前の段の結果として今どのエラーを見て
 * いるか」を引き継ぐ必要があるため error 変数を持ち回る（postgrest 版の
 * `error &&` ガードの再現）。updateData は呼び出し元と共有する同一オブジェクト
 * 参照であることを前提に、各段で該当キーを delete する（postgrest 版と同じ
 * 副作用の与え方。呼び出し元はこの delete 結果を使ってレスポンスの
 * gacha_sound_url/enabled をエコーバックする）。
 *
 * UPDATE は明示値による全置換のため、各段の個別クエリはリトライしても最終
 * 状態が変わらない = 冪等（idempotent: true）。ただし各段の「列を1つ剥がして
 * 再試行する」フォールバックチェイン自体は withDbRetry の接続リトライとは
 * 独立したデプロイ窓ロジックであり、混同しない。
 */
async function applyStreamerSettingsUpdatePg(
  streamerId: string,
  updateData: Record<string, unknown>,
  gachaSoundRulesRequested: boolean
): Promise<ApplyStreamerSettingsUpdateResult> {
  let rarityWeightsScopeWriteSkipped = false;
  let packRarityWeightsWriteSkipped = false;
  let cardPackNamesWriteSkipped = false;
  let defaultCardPackNameWriteSkipped = false;
  let gachaSoundRulesWriteSkipped = false;

  const runUpdate = (data: Record<string, unknown>, context: string) =>
    withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .update(streamersTable)
          .set(data as Partial<typeof streamersTable.$inferInsert>)
          .where(eq(streamersTable.id, streamerId));
      },
      context,
      { idempotent: true },
    );

  const attempt = async (data: Record<string, unknown>, context: string): Promise<unknown> => {
    if (Object.keys(data).length === 0) {
      return null;
    }
    try {
      await runUpdate(data, context);
      return null;
    } catch (err) {
      return err;
    }
  };

  let error: unknown = null;
  try {
    await runUpdate(updateData, "applyStreamerSettingsUpdate(full)");
  } catch (err) {
    error = err;
  }

  if (error && isMissingRarityWeightsScopeColumnError(error as GenericDbError) && "rarity_weights_scope" in updateData) {
    delete updateData.rarity_weights_scope;
    rarityWeightsScopeWriteSkipped = true;
    error = await attempt(updateData, "applyStreamerSettingsUpdate(no rarity_weights_scope)");
  }

  if (error && isMissingPackRarityWeightsColumnError(error as GenericDbError) && "pack_rarity_weights" in updateData) {
    delete updateData.pack_rarity_weights;
    packRarityWeightsWriteSkipped = true;
    error = await attempt(updateData, "applyStreamerSettingsUpdate(no pack_rarity_weights)");
  }

  if (error && isMissingCardPackNamesColumnError(error as GenericDbError) && "card_pack_names" in updateData) {
    delete updateData.card_pack_names;
    cardPackNamesWriteSkipped = true;
    error = await attempt(updateData, "applyStreamerSettingsUpdate(no card_pack_names)");
  }

  if (error && isMissingDefaultCardPackNameColumnError(error as GenericDbError) && "default_card_pack_name" in updateData) {
    delete updateData.default_card_pack_name;
    defaultCardPackNameWriteSkipped = true;
    error = await attempt(updateData, "applyStreamerSettingsUpdate(no default_card_pack_name)");
  }

  if (error && isMissingCollectionNameColumn(error as GenericDbError) && "channel_point_collection_name" in updateData) {
    delete updateData.channel_point_collection_name;
    error = await attempt(updateData, "applyStreamerSettingsUpdate(no channel_point_collection_name)");
  }

  if (error && gachaSoundRulesRequested && isMissingGachaSoundRulesColumnError(error)) {
    logger.warn("gacha_sound_rules column not available yet; saving legacy sound fallback only");
    const legacyUpdateData = { ...updateData };
    delete legacyUpdateData.gacha_sound_rules;
    gachaSoundRulesWriteSkipped = true;
    error = await attempt(legacyUpdateData, "applyStreamerSettingsUpdate(legacy gacha sound fallback)");
  }

  return {
    error,
    rarityWeightsScopeWriteSkipped,
    packRarityWeightsWriteSkipped,
    cardPackNamesWriteSkipped,
    defaultCardPackNameWriteSkipped,
    gachaSoundRulesWriteSkipped,
  };
}

async function applyStreamerSettingsUpdatePostgrest(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  updateData: Record<string, unknown>,
  gachaSoundRulesRequested: boolean
): Promise<ApplyStreamerSettingsUpdateResult> {
  let rarityWeightsScopeWriteSkipped = false;
  let packRarityWeightsWriteSkipped = false;
  let cardPackNamesWriteSkipped = false;
  let defaultCardPackNameWriteSkipped = false;
  let gachaSoundRulesWriteSkipped = false;

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
    gachaSoundRulesRequested &&
    (error.code === "PGRST204" || error.message.includes("gacha_sound_rules"))
  ) {
    logger.warn("gacha_sound_rules column not available yet; saving legacy sound fallback only");
    const legacyUpdateData = { ...updateData };
    delete legacyUpdateData.gacha_sound_rules;
    gachaSoundRulesWriteSkipped = true;
    const fallbackResult = await supabaseAdmin
      .from("streamers")
      .update(legacyUpdateData)
      .eq("id", streamerId);
    error = fallbackResult.error;
  }

  return {
    error: error ?? null,
    rarityWeightsScopeWriteSkipped,
    packRarityWeightsWriteSkipped,
    cardPackNamesWriteSkipped,
    defaultCardPackNameWriteSkipped,
    gachaSoundRulesWriteSkipped,
  };
}

async function applyStreamerSettingsUpdate(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  updateData: Record<string, unknown>,
  gachaSoundRulesRequested: boolean
): Promise<ApplyStreamerSettingsUpdateResult> {
  // #663: 書き込みのみの関数のため isPgWriteEnabled() で分岐。
  if (isPgWriteEnabled()) {
    return applyStreamerSettingsUpdatePg(streamerId, updateData, gachaSoundRulesRequested);
  }
  return applyStreamerSettingsUpdatePostgrest(supabaseAdmin, streamerId, updateData, gachaSoundRulesRequested);
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

    // Verify ownership + read current state (channel_point_collection_name,
    // card_pack_names, pack_rarity_weights), with the 3-level deploy-window
    // fallback chain.
    const streamer = await getStreamerForSettingsUpdate(supabaseAdmin, streamerId, session.twitchUserId);

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

    // gachaSoundRules が送られた場合に「実際に正規化・保存対象となった値」を
    // レスポンスでエコーバックするため、if ブロックの外側に持ち出しておく
    // (F5: 楽観反映によるサイレント欠損対策。cardPackNames と同じパターン)。
    let persistedGachaSoundRules: GachaSoundRule[] | undefined;

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
      if (gachaSoundUrl !== null && !isAllowedSoundUrl(gachaSoundUrl)) {
        return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
      }
      updateData.gacha_sound_url = gachaSoundUrl;
    }
    // gachaSoundEnabled: 効果音の有効/無効フラグ
    if (gachaSoundEnabled !== undefined) {
      updateData.gacha_sound_enabled = gachaSoundEnabled;
    }
    if (gachaSoundRules !== undefined) {
      // 複数ルール・ターゲット指定は支援プラン以上限定の機能
      // Multi-rule and targeting are premium features; reject for basic plan users
      const plan = await getUserPlan(session.twitchUserId);
      if (plan === "basic") {
        return NextResponse.json({ error: ERROR_MESSAGES.PLAN_UPGRADE_REQUIRED }, { status: 403 });
      }
      const rules = normalizeGachaSoundRules(gachaSoundRules);
      updateData.gacha_sound_rules = rules;
      persistedGachaSoundRules = rules;
      // PR #451 レビュー指摘(F1): gacha_sound_url/gacha_sound_enabled は
      // レアリティ／報酬別ルールに対応していない旧オーバーレイクライアント
      // (キャッシュ済み・未更新のブラウザソース)との互換のためだけに残す
      // ミラーである。以前は「有効な最初のルール」を無条件にミラーしていたため、
      // 例えば 'legendary' 限定ルールしか設定していなくても、そのURLが
      // 全レアリティ共通のフォールバックとして保存され、
      // オーバーレイ側のno-matchフォールバック(修正後は空)と組み合わさる前は
      // 「全レアリティでレジェンダリー音が鳴る」事故を起こしていた。
      // catch-all(targetType === "all")の有効ルールが無い設定では、
      // 「常に鳴らしてよい音」は存在しないため、ミラーせず null/false にする。
      const fallbackRule = rules.find((rule) => rule.enabled && rule.targetType === "all") ?? null;
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
      const disconnectFailure = await disconnectBotAccount(supabaseAdmin, streamerId);
      if (disconnectFailure) {
        return handleDatabaseError(disconnectFailure.error, disconnectFailure.context);
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
    // Issue #176/#451フォローアップ(F5): gacha_sound_rules も同じ理由(デプロイ窓)で
    // skip-and-flag パターンを踏襲する。列を剥がしてのリトライ自体は既存の
    // グレースフルデグレード(下記)がやっていたが、フラグが立っておらず
    // クライアントには常に「保存できた」と返っていた(=楽観反映によるサイレント欠損)。
    let gachaSoundRulesWriteSkipped = false;

    if (Object.keys(updateData).length > 0) {
      const updateResult = await applyStreamerSettingsUpdate(
        supabaseAdmin,
        streamerId,
        updateData,
        gachaSoundRules !== undefined
      );
      rarityWeightsScopeWriteSkipped = updateResult.rarityWeightsScopeWriteSkipped;
      packRarityWeightsWriteSkipped = updateResult.packRarityWeightsWriteSkipped;
      cardPackNamesWriteSkipped = updateResult.cardPackNamesWriteSkipped;
      defaultCardPackNameWriteSkipped = updateResult.defaultCardPackNameWriteSkipped;
      gachaSoundRulesWriteSkipped = updateResult.gachaSoundRulesWriteSkipped;

      if (updateResult.error) {
        return handleDatabaseError(updateResult.error, "Streamer Settings API: PUT");
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
      // F5(#451フォローアップ): クライアント(GachaSoundSettings)は保存成功時に
      // 送信した配列をそのまま楽観反映していたが、サーバ側の正規化
      // (normalizeGachaSoundRules: 不正URL除外・デッドルール除外・件数上限)や
      // デプロイ窓でのスキップにより実際の永続値と食い違うことがあった
      // (200を返しつつ実は保存されていない/一部削られている、というサイレント欠損)。
      // cardPackNames/packRarityWeights と同じパターンで、実際に永続化された
      // 値を常にエコーバックしクライアントに再同期させる。デプロイ窓でスキップ
      // した場合は、gacha_sound_rules 列自体には書き込めていないため、実際に
      // 書き込めた旧来ミラー列(gacha_sound_url/gacha_sound_enabled)から
      // 「実態」を復元して返す(=多くの場合、催促ルールが1件も無い空配列)。
      ...(persistedGachaSoundRules !== undefined
        ? {
            gachaSoundRules: gachaSoundRulesWriteSkipped
              ? legacySoundToRules(
                  typeof updateData.gacha_sound_url === "string" ? updateData.gacha_sound_url : null,
                  updateData.gacha_sound_enabled === true
                )
              : persistedGachaSoundRules,
          }
        : {}),
      ...(gachaSoundRulesWriteSkipped ? { gachaSoundRulesSkippedDeployWindow: true } : {}),
    });
  } catch (error) {
    return handleApiError(error, "Streamer Settings API: General");
  }
}
