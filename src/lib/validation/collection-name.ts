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
