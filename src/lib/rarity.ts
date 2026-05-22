import {
  RARITIES,
  RARITY_COLORS,
  RARITY_GLOW,
  RARITY_GRADIENT_COLORS,
} from "./constants";

export type DefaultRarity = (typeof RARITIES)[number]["value"];

export const DEFAULT_RARITY_COLOR_CLASS = "bg-gray-500";
export const DEFAULT_RARITY_GRADIENT_CLASS = "from-gray-400 to-gray-600";
export const DEFAULT_RARITY_GLOW_CLASS = "shadow-gray-500/50";

export function isDefaultRarity(rarity: string): rarity is DefaultRarity {
  return RARITIES.some((item) => item.value === rarity);
}

export function formatRarityLabel(
  rarity: string,
  translate: (key: DefaultRarity) => string,
): string {
  return isDefaultRarity(rarity) ? translate(rarity) : rarity;
}

/**
 * レアリティのバッジ表示情報（ラベル・色クラス）を返す。
 *
 * デフォルトレアリティは RARITIES のプリセット（固定の日本語ラベルと色）を使う。
 * カスタムレアリティは RARITIES に存在しないため、生のレアリティ名をラベルとし、
 * 色は getRarityColorClass のフォールバック（DEFAULT_RARITY_COLOR_CLASS）を使う。
 *
 * 従来各コンポーネントに重複していた `RARITIES.find(...) || RARITIES[0]` は、
 * カスタムレアリティを誤って「コモン」に丸めて表示するバグがあったため、
 * graceful な本ヘルパに集約する。
 */
export function getRarityDisplayInfo(
  rarity: string,
): { value: string; label: string; color: string } {
  const preset = RARITIES.find((item) => item.value === rarity);
  if (preset) {
    return { value: preset.value, label: preset.label, color: preset.color };
  }
  return { value: rarity, label: rarity, color: getRarityColorClass(rarity) };
}

export function getRarityColorClass(rarity: string): string {
  return RARITY_COLORS[rarity] ?? DEFAULT_RARITY_COLOR_CLASS;
}

/**
 * カスタムレアリティ（デフォルト4種以外）ごとのユニーク数を集計する。
 *
 * レアリティ別内訳を4固定で数えると合計が unique と一致しないため、
 * コレクション/ダッシュボードのサマリーでカスタム分も内訳に含める用途。
 * レアリティ名の昇順で安定整列して返す。
 */
export function aggregateCustomRarities(
  cards: { rarity: string }[],
): { rarity: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (!isDefaultRarity(card.rarity)) {
      counts.set(card.rarity, (counts.get(card.rarity) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([rarity, count]) => ({ rarity, count }))
    .sort((a, b) => a.rarity.localeCompare(b.rarity));
}

export function getRarityGradientClass(rarity: string): string {
  return RARITY_GRADIENT_COLORS[rarity] ?? DEFAULT_RARITY_GRADIENT_CLASS;
}

export function getRarityGlowClass(rarity: string): string {
  return RARITY_GLOW[rarity] ?? DEFAULT_RARITY_GLOW_CLASS;
}

export const GUARANTEED_RARITY_VALUES = ["rare", "epic", "legendary"] as const;

export type GuaranteedRarity = (typeof GUARANTEED_RARITY_VALUES)[number];

const RARITY_RANK: Record<string, number> = {
  common: 0,
  rare: 1,
  epic: 2,
  legendary: 3,
};

export function isGuaranteedRarity(value: unknown): value is GuaranteedRarity {
  return typeof value === "string" && GUARANTEED_RARITY_VALUES.includes(value as GuaranteedRarity);
}

export function normalizeGuaranteedRarity(value: unknown): GuaranteedRarity | null {
  if (value === undefined || value === null || value === "") return null;
  return isGuaranteedRarity(value) ? value : null;
}

export function meetsRarityFloor(cardRarity: string, floor: GuaranteedRarity): boolean {
  const cardRank = RARITY_RANK[cardRarity];
  const floorRank = RARITY_RANK[floor];
  if (cardRank === undefined || floorRank === undefined) return false;
  return cardRank >= floorRank;
}
