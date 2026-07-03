import {
  RARITIES,
  RARITY_COLORS,
  RARITY_GLOW,
  RARITY_GRADIENT_COLORS,
  RARITY_ORDER,
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

/**
 * レアリティのソート優先順位（数値ランク）を返す。値が小さいほど希少
 * （RARITY_ORDER の先頭 = legendary = 0）。
 *
 * RARITY_ORDER はビルトイン4種のみを含む固定配列のため、配信者が定義した
 * カスタムレアリティは Array.prototype.indexOf で見つからず -1 になる。
 * 呼び出し側がこの -1 をそのまま比較に使うと、"-1 - 0 = -1" となり
 * カスタムレアリティが legendary (index 0) より希少と誤判定され、
 * 一覧の先頭に来てしまうバグがあった（Issue #505）。
 * ここでは -1 を Number.POSITIVE_INFINITY に変換し、カスタムレアリティが
 * 常に一覧の最後に来るようにする。
 *
 * 同じ考え方は gacha-sound-rules.ts の pickSoundBearingCardIndex で
 * 既に使われている（PR #451/#595 followup）。このヘルパーは
 * dashboard/page.tsx と collection-utils.ts の同種のソート箇所で
 * 重複していたロジックを1箇所に集約したもの。
 */
export function getRarityRank(rarity: string): number {
  const index = RARITY_ORDER.indexOf(rarity);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/**
 * レアリティのみを基準にした Array.prototype.sort 用比較関数。
 * legendary が先頭、カスタムレアリティは末尾に来る（getRarityRank 参照）。
 */
export function compareByRarity(a: { rarity: string }, b: { rarity: string }): number {
  return getRarityRank(a.rarity) - getRarityRank(b.rarity);
}

export function getRarityGlowClass(rarity: string): string {
  return RARITY_GLOW[rarity] ?? DEFAULT_RARITY_GLOW_CLASS;
}
