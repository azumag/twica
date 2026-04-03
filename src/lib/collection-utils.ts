import { RARITY_ORDER } from "@/lib/constants";
import type { Card } from "@/types/database";

type SortableCollectionCard = Pick<Card, "rarity" | "created_at">;

/**
 * Sort owned cards for collection views.
 * Rarity is primary (legendary first), then newest first within the same rarity.
 */
export function sortCollectedCards<T extends SortableCollectionCard>(cards: T[]): T[] {
  return [...cards].sort((a, b) => {
    const rarityDiff = RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
    if (rarityDiff !== 0) return rarityDiff;

    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

/**
 * Count unique owned cards that are still active for progress calculations.
 */
export function countOwnedActiveCardTypes<T extends { id: string }>(
  cards: T[],
  activeCardIds: Iterable<string>
): number {
  const activeIdSet = activeCardIds instanceof Set ? activeCardIds : new Set(activeCardIds);

  return new Set(
    cards
      .filter((card) => activeIdSet.has(card.id))
      .map((card) => card.id)
  ).size;
}
