// Issue #557: pure helpers for the viewer collection page's pack filter and
// per-pack completion progress.
//
// Intentionally PURE (no DB / no React / no server-only imports), mirroring
// collection-utils.ts, so the grouping/progress logic is unit-testable and
// safely importable from both the Server Component page and the client-side
// filter component.
//
// 課題 #557: コレクションページのパックフィルタ/パック別進捗の純粋関数。
// collection-utils.ts と同じく DB・React 非依存とし、Server/Client 双方から
// 安全に import できるようにする。

import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import { countOwnedActiveCardTypes } from "@/lib/collection-utils";

/** The minimal card shape these helpers need (subset of Card). */
export interface PackGroupableCard {
  id: string;
  collection_name: string | null;
}

export interface CollectionPackGroup {
  // Filter key: the pack's collection_name, or DEFAULT_PACK_SENTINEL for the
  // default (unclassified) pseudo-pack. The sentinel is used because NULL
  // cannot be a client-side filter value distinguishable from "no filter"
  // (same rationale as the pack <select>s introduced in #555).
  key: string;
  isDefault: boolean;
}

/**
 * Does a card belong to the pack identified by `packKey`?
 * DEFAULT_PACK_SENTINEL selects unclassified cards (collection_name === null);
 * any other key is an exact collection_name match. This is the same sentinel
 * resolution rule executeGacha / checkCollectionHasActiveCards already apply
 * on their DB queries (`.is(...)` vs `.eq(...)`), expressed as an in-memory
 * predicate.
 */
export function cardMatchesPackKey(
  collectionName: string | null,
  packKey: string
): boolean {
  return packKey === DEFAULT_PACK_SENTINEL
    ? collectionName === null
    : collectionName === packKey;
}

/**
 * Derive the pack groups to offer on the collection page from the streamer's
 * ACTIVE cards.
 *
 * - The default (unclassified) group comes first, and ONLY when at least one
 *   active card is unclassified — an empty pseudo-pack would show a 0/0
 *   progress bar that can never complete. Ordering mirrors the existing
 *   "all → default → named packs" option order of the pack selects (#555).
 * - Named packs are ordered by the streamer's catalog (streamers.
 *   card_pack_names) so the filter matches the order streamers curated.
 *   Only packs that actually have at least one active card are offered
 *   (an empty filter tab would always show an empty grid).
 * - Orphaned names (still set on cards but removed from the catalog) are
 *   appended last, in first-seen active-card order — hiding them would make
 *   those cards unreachable through any single pack tab (mirrors CardManager's
 *   pack filter, which also keeps orphaned names selectable).
 */
export function deriveCollectionPackGroups(
  activeCards: PackGroupableCard[],
  catalogOrder: string[]
): CollectionPackGroup[] {
  const namesOnCards: string[] = [];
  const seen = new Set<string>();
  let hasUnclassified = false;

  for (const card of activeCards) {
    if (card.collection_name === null) {
      hasUnclassified = true;
      continue;
    }
    if (!seen.has(card.collection_name)) {
      seen.add(card.collection_name);
      namesOnCards.push(card.collection_name);
    }
  }

  const catalogSet = new Set(catalogOrder);
  const orderedNames = [
    // Catalog order first (only those with active cards)...
    ...catalogOrder.filter((name) => seen.has(name)),
    // ...then orphans in first-seen order.
    ...namesOnCards.filter((name) => !catalogSet.has(name)),
  ];

  return [
    ...(hasUnclassified
      ? [{ key: DEFAULT_PACK_SENTINEL, isDefault: true }]
      : []),
    ...orderedNames.map((name) => ({ key: name, isDefault: false })),
  ];
}

/**
 * Compute owned/total progress for one pack.
 * total = unique ACTIVE card types in the pack; owned = of those, the ones
 * the viewer owns (delegates the unique-and-active counting to the existing
 * countOwnedActiveCardTypes helper so overall and per-pack progress can never
 * disagree on counting rules).
 */
export function computePackProgress(
  ownedCards: { id: string }[],
  activeCards: PackGroupableCard[],
  packKey: string
): { owned: number; total: number } {
  const packActiveIds = new Set(
    activeCards
      .filter((card) => cardMatchesPackKey(card.collection_name, packKey))
      .map((card) => card.id)
  );

  return {
    owned: countOwnedActiveCardTypes(ownedCards, packActiveIds),
    total: packActiveIds.size,
  };
}

/**
 * Issue #597: resolve the display name of a pack key for the `{packName}`
 * chat announcement placeholder.
 *
 * Originally (#597) the caller always passed the pack the gacha draw was
 * SCOPED to. Since #948 the chat caller (sendChatAnnouncement) passes the
 * obtained card's own pack key instead — `DEFAULT_PACK_SENTINEL` for
 * unclassified cards — and only falls back to the draw scope for
 * pre-migration outbox payloads that lack the card's `collection_name`.
 * This helper stays agnostic to that choice: it just maps a pack key to a
 * display name.
 *
 * Mirrors the 3 states the collection page (page.tsx) already distinguishes
 * for `CollectionPackDisplay.displayName`, just resolved eagerly instead of
 * being left for a client component to fall back on:
 * - `collectionName` is null/undefined — no pack information (legacy payload
 *   with unrestricted draw) → `''` (stripped by chat-service's optional
 *   placeholder handling, same convention as `{newCards}` when absent).
 * - `collectionName === DEFAULT_PACK_SENTINEL` — restricted to the default
 *   (unclassified) pseudo-pack → the streamer's override (`defaultPackName`,
 *   i.e. `streamers.default_card_pack_name`), or `defaultPackFallbackLabel`
 *   when no override is set (same fallback pattern as
 *   ChannelPointSettings' `defaultPackDisplayName`, #554).
 * - any other `collectionName` IS the display name (named packs don't have a
 *   separate display-name column — the registered pack name itself is shown
 *   everywhere else, see #393) → returned verbatim.
 *
 * `defaultPackFallbackLabel` is injected by the caller (rather than hardcoded
 * here) so this module stays free of display strings/i18n, matching how
 * `CollectionPackDisplay.displayName` also leaves that resolution to callers.
 */
export function resolvePackDisplayName(
  collectionName: string | null | undefined,
  defaultPackName: string | null,
  defaultPackFallbackLabel: string
): string {
  if (!collectionName) return "";
  if (collectionName === DEFAULT_PACK_SENTINEL) {
    return defaultPackName ?? defaultPackFallbackLabel;
  }
  return collectionName;
}
