import { getRarityRank } from "@/lib/rarity";
import type { Card } from "@/types/database";

export type CollectionSortMode = "rarity" | "number";

type SortableCollectionCard = Pick<Card, "id" | "rarity" | "created_at"> & {
  collectionNumber?: number;
};

type NumberableCollectionCard = Pick<Card, "id" | "created_at"> & {
  card_number?: number | null;
};

/**
 * Sort owned cards for collection views.
 * Defaults to rarity first (legendary first), with optional encyclopedia number order.
 */
export function sortCollectedCards<T extends SortableCollectionCard>(
  cards: T[],
  mode: CollectionSortMode = "rarity"
): T[] {
  return [...cards].sort((a, b) => {
    if (mode === "number") {
      const numberDiff =
        (a.collectionNumber ?? Number.MAX_SAFE_INTEGER) -
        (b.collectionNumber ?? Number.MAX_SAFE_INTEGER);
      if (numberDiff !== 0) return numberDiff;
    }

    // getRarityRank: 未知の(カスタム)レアリティはビルトインより後ろに来るよう
    // Number.POSITIVE_INFINITY を返す（Issue #505、gacha-sound-rules.ts と同じ考え方）
    const rarityDiff = getRarityRank(a.rarity) - getRarityRank(b.rarity);
    if (rarityDiff !== 0) return rarityDiff;

    const createdAtDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (createdAtDiff !== 0) return createdAtDiff;

    return a.id.localeCompare(b.id);
  });
}

/**
 * Build stable encyclopedia-style card numbers for a streamer's cards.
 * Manually assigned card_number values are honored first.
 * Remaining cards are filled into the next available numbers by oldest created_at first,
 * and duplicate owned-card rows are ignored.
 */
export function createCollectionNumberMap<T extends NumberableCollectionCard>(
  cards: T[]
): Map<string, number> {
  const uniqueCards = new Map<string, T>();
  for (const card of cards) {
    const existing = uniqueCards.get(card.id);
    if (
      !existing ||
      new Date(card.created_at).getTime() < new Date(existing.created_at).getTime()
    ) {
      uniqueCards.set(card.id, card);
    }
  }

  const sortedCards = [...uniqueCards.values()].sort((a, b) => {
    const createdAtDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (createdAtDiff !== 0) return createdAtDiff;

    return a.id.localeCompare(b.id);
  });

  const numberMap = new Map<string, number>();
  const usedNumbers = new Set<number>();

  for (const card of sortedCards) {
    if (
      typeof card.card_number === "number" &&
      Number.isInteger(card.card_number) &&
      card.card_number > 0 &&
      !usedNumbers.has(card.card_number)
    ) {
      numberMap.set(card.id, card.card_number);
      usedNumbers.add(card.card_number);
    }
  }

  let nextNumber = 1;
  for (const card of sortedCards) {
    if (numberMap.has(card.id)) continue;
    while (usedNumbers.has(nextNumber)) {
      nextNumber++;
    }
    numberMap.set(card.id, nextNumber);
    usedNumbers.add(nextNumber);
  }

  return numberMap;
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
