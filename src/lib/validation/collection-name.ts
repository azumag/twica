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
    if (typeof raw !== "string") {
      return { ok: false };
    }
    const trimmed = raw.trim();
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
