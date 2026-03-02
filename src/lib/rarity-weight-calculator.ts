export interface RarityWeightCardInput {
  id: string;
  rarity: string;
  is_active: boolean;
}

export interface DropRateCalculationResult {
  id: string;
  dropRate: number;
}

function roundTo4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function isValidPercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * Calculate drop_rate per active card based on rarity target percentages.
 *
 * Rules:
 * - Only active cards are recalculated.
 * - Existing card rarities are detected dynamically (no fixed rarity list).
 * - If a card rarity is missing in rarityWeights, fallback to equal weight per active card.
 * - Result is rounded to 4 decimal places to match DECIMAL(5,4).
 */
export function calculateDropRates(
  cards: RarityWeightCardInput[],
  rarityWeights: Record<string, number>
): DropRateCalculationResult[] {
  const activeCards = cards.filter((card) => card.is_active);
  if (activeCards.length === 0) {
    return [];
  }

  const rarityCounts = new Map<string, number>();
  for (const card of activeCards) {
    rarityCounts.set(card.rarity, (rarityCounts.get(card.rarity) || 0) + 1);
  }

  const fallbackPerCard = roundTo4(1 / activeCards.length);
  const perRarityWeight = new Map<string, number>();

  for (const [rarity, count] of rarityCounts.entries()) {
    const targetPercent = rarityWeights[rarity];
    if (isValidPercent(targetPercent)) {
      perRarityWeight.set(rarity, roundTo4((targetPercent / 100) / count));
    } else {
      perRarityWeight.set(rarity, fallbackPerCard);
    }
  }

  return activeCards.map((card) => ({
    id: card.id,
    dropRate: perRarityWeight.get(card.rarity) ?? fallbackPerCard,
  }));
}
