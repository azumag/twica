export interface RarityWeightCardInput {
  id: string;
  rarity: string;
  is_active: boolean;
  // レアリティ内重み（デフォルト1.0=均等配分）
  intra_rarity_weight?: number;
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
 * - If a card rarity is missing/invalid in rarityWeights, the card drop rate is 0
 *   (excluded from gacha). A per-card equal fallback would let unconfigured
 *   rarities silently inflate the total well beyond the 100% the operator set,
 *   breaking the rarity-weight design. 0 keeps the configured totals intact.
 * - intra_rarity_weight controls distribution within a rarity (default 1.0 = equal share).
 *   Formula: card_rate = (rarity_pct / 100) * (card_intra_weight / sum_intra_weights_in_rarity)
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

  // レアリティごとのカード一覧とintra_rarity_weightの合計を集計
  const rarityGroups = new Map<string, { cards: RarityWeightCardInput[]; totalIntraWeight: number }>();
  for (const card of activeCards) {
    const intraWeight = card.intra_rarity_weight ?? 1.0;
    const group = rarityGroups.get(card.rarity);
    if (group) {
      group.cards.push(card);
      group.totalIntraWeight += intraWeight;
    } else {
      rarityGroups.set(card.rarity, { cards: [card], totalIntraWeight: intraWeight });
    }
  }

  return activeCards.map((card) => {
    const targetPercent = rarityWeights[card.rarity];
    const group = rarityGroups.get(card.rarity);

    // レアリティ重みが未設定/不正なカードは排出対象外(0%)。
    // 均等配分のフォールバックを行うと、運用者が設定した合計100%を
    // 未設定レアリティが押し上げてしまい、レアリティ重み設計が破綻するため。
    if (!isValidPercent(targetPercent) || !group) {
      return { id: card.id, dropRate: 0 };
    }

    const intraWeight = card.intra_rarity_weight ?? 1.0;
    // card_rate = (rarity_pct / 100) * (intra_weight / total_intra_weight_in_rarity)
    const dropRate = roundTo4((targetPercent / 100) * (intraWeight / group.totalIntraWeight));
    return { id: card.id, dropRate };
  });
}
