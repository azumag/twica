// Issue #393: shared validation helpers for card pack ("collection") names.
//
// This module is intentionally PURE (no DB / no server-only imports) so it can be
// safely imported from both client components and server routes. The actual
// "does this pack contain drawable cards?" existence check lives in the
// server-only helper `@/lib/collections/collection-existence` because it reads
// the database via the admin client.
//
// 課題 #393: カードパック(collection)名の共有バリデーション。
// 本モジュールは DB 非依存の純粋関数のみとし、client component からも安全に
// import できるようにする。DB を読む存在検証は server-only の
// `@/lib/collections/collection-existence` に分離している。
//
// Redesign (post-#393/#269): pack names are now a pre-defined, streamer-managed
// list (`streamers.card_pack_names`) rather than free text typed on any card.
// `validateCardPackNamesInput` validates that list; `isRegisteredOrUnchanged`
// gates individual card/reward assignments against it.

import { MAX_CARD_PACK_NAMES, RARITY_CONTROL_CHAR_REGEX, RARITY_BIDI_OVERRIDE_REGEX } from "@/lib/constants";

/** Maximum length of a collection (pack) name. Mirrors the DB CHECK constraint. */
export const MAX_COLLECTION_NAME_LENGTH = 80;

/**
 * Normalize a raw collection-name input.
 *
 * Return value contract (callers MUST distinguish all three):
 * - `undefined` → the input was `undefined` (field omitted) OR an invalid type
 *   (e.g. a number/object). Callers decide the meaning by inspecting whether the
 *   property was actually present on the request body (use `Object.hasOwn`), and
 *   return 400 when the property was present but normalized to `undefined`.
 * - `null`      → an explicit "clear / all cards" request (input was `null` or a
 *   blank/whitespace-only string).
 * - `string`    → a trimmed, non-empty pack name.
 *
 * Normalization is `trim()` only by design. Case folding / NFC / full-width
 * normalization are intentionally NOT applied (YAGNI): display-string variants
 * such as "Pokemon" vs "pokemon" are treated as distinct packs, matching how
 * streamers type free-form names. This keeps behavior predictable and avoids
 * silently merging packs the streamer considers different.
 *
 * 正規化は `trim()` のみ。大小文字/NFC/全半角は意図的に非対応(YAGNI)。
 */
export function normalizeCollectionName(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate a collection-name field on a request body and resolve the value to
 * persist. Centralizes the "property present but invalid → 400" guard so every
 * caller behaves identically.
 *
 * @param body  the parsed request body
 * @param key   the property name to read (e.g. "collectionName")
 * @returns
 *  - `{ ok: true, value }` where `value` is `string | null | undefined`
 *    (`undefined` only when the property was absent — caller should skip the column).
 *  - `{ ok: false }` when the property was present but is an invalid type or too long.
 */
export function resolveCollectionNameField(
  body: Record<string, unknown>,
  key: string
): { ok: true; value: string | null | undefined } | { ok: false } {
  // Use Object.hasOwn (NOT a truthy check) so "" / null are treated as "present".
  const provided = Object.hasOwn(body, key);
  if (!provided) {
    return { ok: true, value: undefined };
  }

  const raw = body[key];
  const normalized = normalizeCollectionName(raw);

  // Property was present but normalized to undefined → invalid type (e.g. number).
  if (normalized === undefined) {
    return { ok: false };
  }

  if (normalized !== null && normalized.length > MAX_COLLECTION_NAME_LENGTH) {
    return { ok: false };
  }

  return { ok: true, value: normalized };
}

/**
 * Issue #555: sentinel value meaning "the default (unclassified) pack" — i.e.
 * cards whose `collection_name` is NULL. Streamers can already select "all
 * cards" (no filter) or a named pack; this sentinel adds a third, distinct
 * choice ("only the cards nobody assigned to a pack") without needing a real
 * DB value to represent NULL-ness inside a `<select>` (HTML option values are
 * always strings, so NULL itself cannot be an option value).
 *
 * The `__` prefix is deliberately chosen so it can never collide with a
 * streamer-typed pack name: `isReservedCollectionName` rejects the entire
 * `__`-prefixed namespace at registration time (see `validateCardPackNamesInput`),
 * so no real pack can ever equal this sentinel.
 *
 * デフォルト(未分類)パックを表す予約値。HTML の <select> は NULL を直接
 * 値として持てないため、この文字列で代替する。`__` 始まりの名前は
 * `isReservedCollectionName` により登録時点で拒否されるため、実際の
 * パック名と衝突することはない。
 */
export const DEFAULT_PACK_SENTINEL = "__default__";

/**
 * Reserved-name guard for card pack names (`streamers.card_pack_names`).
 * Names starting with `__` are reserved for sentinel values such as
 * `DEFAULT_PACK_SENTINEL` and must never be registrable as a real pack name —
 * otherwise a streamer-created pack literally named "__default__" would
 * collide with the default-pack UI option and silently change its meaning
 * (from "a named pack" to "unclassified cards").
 *
 * `__` で始まるパック名を予約語として扱う。`DEFAULT_PACK_SENTINEL` 等の
 * 予約値と衝突する実パックの登録を防ぐ。
 */
export function isReservedCollectionName(name: string): boolean {
  return name.startsWith("__");
}

export type PackNameValidation = { ok: true; value: string } | { ok: false };

/**
 * Validate a single, standalone pack-name string: trim, length 1-80, no
 * control/Bidi-override characters, and not `__`-reserved.
 *
 * Issue #554: this is the single-value counterpart to
 * `validateCardPackNamesInput`'s per-element checks (extracted so the rename
 * API's `newName` and the streamer's `default_card_pack_name` display-name
 * override can share the exact same rule set without duplicating it — a
 * streamer typing an invalid name should get the identical rejection reason
 * regardless of which field they're editing). List-only concerns
 * (de-duplication, item-count cap) stay in `validateCardPackNamesInput`,
 * which now delegates its per-element validation to this function.
 */
export function validatePackName(value: unknown): PackNameValidation {
  if (typeof value !== "string") {
    return { ok: false };
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 1
    || trimmed.length > MAX_COLLECTION_NAME_LENGTH
    || RARITY_CONTROL_CHAR_REGEX.test(trimmed)
    || RARITY_BIDI_OVERRIDE_REGEX.test(trimmed)
    // Issue #555: `__`-prefixed names are reserved for sentinels like
    // DEFAULT_PACK_SENTINEL and must never be registrable as a real pack.
    || isReservedCollectionName(trimmed)
  ) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export type CardPackNamesValidation =
  | { ok: true; value: string[] }
  | { ok: false };

/**
 * Validate the streamer-managed list of pre-defined card pack names
 * (`streamers.card_pack_names`). Mirrors `validateCustomRaritiesInput`
 * (streamer/settings route) in shape: array of strings, trimmed, length- and
 * count-bounded, control-char/Bidi rejected, no duplicates.
 *
 * Per-element normalization is `trim()` only (NFC/case folding intentionally
 * not applied — see `normalizeCollectionName`). Unlike a single scalar
 * `collectionName`, this list is rendered directly as picker options across
 * the dashboard, so control characters and Bidi override characters are
 * rejected here (custom_rarities applies the same hardening for its list).
 */
export function validateCardPackNamesInput(value: unknown): CardPackNamesValidation {
  if (!Array.isArray(value) || value.length > MAX_CARD_PACK_NAMES) {
    return { ok: false };
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const validation = validatePackName(raw);
    if (!validation.ok) {
      return { ok: false };
    }
    const { value: trimmed } = validation;
    if (seen.has(trimmed)) {
      return { ok: false };
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return { ok: true, value: normalized };
}

/**
 * Determine whether a card/reward's `collectionName` assignment is allowed
 * against the streamer's pre-defined pack list.
 *
 * Always allowed, regardless of registration:
 * - clearing to `null` (never a "new" assignment)
 * - resubmitting the value already stored (`currentValue`) unchanged
 *
 * This keeps a card/reward whose pack was later removed from
 * `card_pack_names` fully editable — deleting a pack from the management
 * list never retroactively breaks unrelated edits to cards that still
 * reference it (mirrors the #269 "clearing/no-op is never gated" stance,
 * applied here to "known pack name" instead of "plan").
 *
 * Only a genuine change to a NEW value must be a member of `registeredNames`.
 */
export function isRegisteredOrUnchanged(
  newValue: string | null,
  currentValue: string | null,
  registeredNames: string[]
): boolean {
  if (newValue === null || newValue === currentValue) {
    return true;
  }
  return registeredNames.includes(newValue);
}

// ---------------------------------------------------------------------------
// Issue #1994: 1つのチャネルポイント報酬に複数のカードパックを割り当てる。
//
// 保存形式: 新しい JSONB 配列列（streamers.channel_point_pack_names /
// streamer_additional_gacha_rewards.reward_pack_names）に選択全体を持ち、旧単一列
// （channel_point_collection_name / collection_name）には常に先頭要素をミラーする。
// 旧列ミラーは、コードをロールバックしても「全カード抽選」へ落ちず、有効な
// 1パックから抽選させるための後方互換（旧コードは旧列しか読まない）。
//
// 意味づけ（gacha.ts の抽選経路と一致させる）:
//   []        → 全カード（現状どおり）
//   [x]       → 現行の単一パック経路（per_pack 重み・{packName} 挙動を含む）
//   [x, y, …] → 和集合プールから抽選する新経路
// ---------------------------------------------------------------------------

/**
 * 1報酬に割り当てられるパック数の上限。
 *
 * 事前登録パックの上限（MAX_CARD_PACK_NAMES = 50, migration 00062 の CHECK）に
 * DEFAULT_PACK_SENTINEL（未分類カード）の1つを足した値。これで「登録済みの全パック
 * + デフォルトパック」を明示的に選べる。これより小さい上限を設けると、パックを
 * 多く登録した配信者だけが特定の組み合わせを表現できなくなるため、カタログ側の
 * 上限に揃える。DB 側の CHECK（jsonb_array_length <= 51）と必ず同じ値にすること
 * （tests/unit/reward-multi-pack-names-migration.test.ts で両者の一致を検査する）。
 */
export const MAX_REWARD_PACK_NAMES = MAX_CARD_PACK_NAMES + 1;

/**
 * 文字列以外・空文字を捨て、先頭出現を残して重複を除く（順序は保持）。
 * 先頭要素は旧単一列へのミラー対象なので、並び替えてはならない。
 */
function dedupePackNames(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * DB から読んだ「配列列」と「旧単一列」から、実効のパック割り当てを解決する。
 * gacha（抽選）・設定 API・追加報酬 API・bootstrap・設定ページがすべてこの関数を
 * 通すことで、フォールバック規則を1か所に閉じ込める（UI は規則を知らなくてよい）。
 *
 * 規則:
 * 1. 配列列が空/null/欠落（デプロイ窓で列が未作成のときは undefined が渡る）なら、
 *    旧単一列を読む。既存データのバックフィルは不要（列の既定値は '[]'）。
 * 2. 配列の先頭が旧単一列と食い違うなら、旧単一列を正とする。新コードは常に
 *    「旧列 = 配列の先頭（空配列なら NULL）」を同じ UPDATE で書くため、食い違いは
 *    配列列を知らない書き手（ロールバックした旧コードなど）が旧列だけを書き換えた
 *    証拠である。その場合に古い配列が勝つと、配信者が旧コードで選び直した設定が
 *    黙って無視されるため、旧列を優先する。
 * 3. それ以外は配列を（重複除去して）そのまま使う。
 */
export function resolveEffectiveRewardPackNames(
  arrayValue: unknown,
  legacyValue: string | null | undefined
): string[] {
  const legacy = typeof legacyValue === "string" && legacyValue.length > 0 ? legacyValue : null;
  const names = Array.isArray(arrayValue) ? dedupePackNames(arrayValue) : [];
  if (names.length === 0 || names[0] !== legacy) {
    return legacy === null ? [] : [legacy];
  }
  return names;
}

/** 旧単一列へ書き込むミラー値（先頭要素、空選択なら NULL = 全カード）。 */
export function toLegacyCollectionName(names: readonly string[]): string | null {
  return names[0] ?? null;
}

export type CollectionNamesFieldResult =
  | { ok: true; value: string[] | undefined }
  | { ok: false };

/**
 * 報酬のパック割り当てをリクエスト body から読み、保存すべき配列へ正規化する。
 *
 * - `arrayKey`（新形式, 例: "collectionNames"）: string[] | null。null / [] は
 *   「全カード」。各要素は `normalizeCollectionName` と同じ trim 規則で正規化し、
 *   空要素・非文字列・80文字超は 400。重複は除去（先頭出現を残す）してから
 *   上限 MAX_REWARD_PACK_NAMES を検査する。
 * - `legacyKey`（旧形式, 例: "collectionName"）: 後方互換の単一値。キャッシュ済みの
 *   旧クライアントや外部呼び出しのため受理し、[name] / [] に変換する。単一値で
 *   保存した場合も配列列を [name] / [] で書き直すことで、古い複数パック配列が
 *   残って勝つことを防ぐ（呼び出し側が両列を同じ UPDATE で書く）。
 * - 両方が同時に送られた場合は優先順位を暗黙に決めず 400 にする。どちらを採用しても
 *   送信者の意図と食い違う可能性があり、黙って片方を捨てるより明示的に拒否する方が
 *   安全なため。
 *
 * 戻り値の `value: undefined` は「どちらのキーも無い = 列を変更しない」。
 * 登録済みパックかどうかの検証は DB 状態が必要なため呼び出し側で行う
 * （findUnregisteredRewardPackName）。
 */
export function resolveCollectionNamesField(
  body: Record<string, unknown>,
  arrayKey: string,
  legacyKey: string
): CollectionNamesFieldResult {
  const arrayProvided = Object.hasOwn(body, arrayKey);
  const legacyProvided = Object.hasOwn(body, legacyKey);

  if (arrayProvided && legacyProvided) {
    return { ok: false };
  }

  if (legacyProvided) {
    const legacy = resolveCollectionNameField(body, legacyKey);
    if (!legacy.ok) return { ok: false };
    return { ok: true, value: typeof legacy.value === "string" ? [legacy.value] : [] };
  }

  if (!arrayProvided) {
    return { ok: true, value: undefined };
  }

  const raw = body[arrayKey];
  if (raw === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false };
  }

  const normalized: string[] = [];
  for (const element of raw) {
    const name = normalizeCollectionName(element);
    // undefined（非文字列）と null（空白のみ）はどちらも不正な要素として扱う。
    // 「全カード」は配列全体を空にして表現する規約で、要素単位の空は意味を持たない。
    if (typeof name !== "string" || name.length > MAX_COLLECTION_NAME_LENGTH) {
      return { ok: false };
    }
    normalized.push(name);
  }

  const deduped = dedupePackNames(normalized);
  if (deduped.length > MAX_REWARD_PACK_NAMES) {
    return { ok: false };
  }
  return { ok: true, value: deduped };
}

/**
 * 複数パック版の membership 検証。`next` のうち、登録済みでも現在の割り当てでも
 * DEFAULT_PACK_SENTINEL でもない最初の名前を返す（全て許可なら null）。
 *
 * 各要素を既存の `isRegisteredOrUnchanged` へ委ねる。「変更なし」は現在の実効
 * 割り当て集合に含まれることで判定する — パック管理で登録解除された（孤立した）
 * パックを含む割り当てでも、他の要素を編集しただけで保存できなくなってはいけない
 * （単一値で確立済みの「孤立参照は値を変えない限り壊れない」方針の複数版）。
 * DEFAULT_PACK_SENTINEL は card_pack_names に登録できない予約値なので、単一値の
 * 経路と同じく membership 検証自体を免除する。
 */
export function findUnregisteredRewardPackName(
  next: readonly string[],
  current: readonly string[],
  registeredNames: string[]
): string | null {
  for (const name of next) {
    if (name === DEFAULT_PACK_SENTINEL) continue;
    const currentValue = current.includes(name) ? name : null;
    if (!isRegisteredOrUnchanged(name, currentValue, registeredNames)) {
      return name;
    }
  }
  return null;
}
