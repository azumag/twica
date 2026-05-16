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

export function getRarityColorClass(rarity: string): string {
  return RARITY_COLORS[rarity] ?? DEFAULT_RARITY_COLOR_CLASS;
}

export function getRarityGradientClass(rarity: string): string {
  return RARITY_GRADIENT_COLORS[rarity] ?? DEFAULT_RARITY_GRADIENT_CLASS;
}

export function getRarityGlowClass(rarity: string): string {
  return RARITY_GLOW[rarity] ?? DEFAULT_RARITY_GLOW_CLASS;
}
