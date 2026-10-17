// Issue #1783: カスタムレアリティの表示スタイル（文字色/バッジ色/グラデーション/
// グロー/エフェクト）を配信者ごとに永続化するための型と検証ヘルパ。
//
// 色はインジェクション対策のため HEX (#RGB / #RRGGBB) のみを許可する。
// 任意 CSS/HTML は通さない。
//
// なぜプリセットの Tailwind クラス（bg-red-500 等）を受理しないか (Issue #1783
// フェーズ2のレビュー指摘): Tailwind v4 はソース走査(JIT)でしかクラスを生成しない
// ため、DBに入ったクラス名は生成CSSに存在せず「受理したのに無色」になる。実測では
// 許可集合（18色×11シェードの bg/from/to/shadow）のうち badge 45/198、
// from 9/198、shadow 5/594 しか生成されていなかった。全組み合わせを safelist すると
// 生成CSSが +303KB 増えるため、受理する形式を「必ず描画できる HEX」に限定する
// （HEX は rarity.ts の getRarityStylePresentation が CSS 変数経由で描画する）。

import { MAX_RARITY_KEY_LENGTH, MAX_CUSTOM_RARITIES, RARITIES } from "@/lib/constants";

export interface RarityStyle {
  /** バッジ/文字色。HEX (#RGB/#RRGGBB)。 */
  color?: string;
  /** グラデーション。HEX ペア（`#RRGGBB,#RRGGBB`）。 */
  gradient?: string;
  /** グロー。HEX (#RGB/#RRGGBB)。 */
  glow?: string;
  /** エフェクトテンプレート名。 */
  effect?: string;
}

export type RarityStyles = Record<string, RarityStyle>;

// 許可する HEX 色形式。
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const MAX_EFFECT_NAME_LENGTH = 40;

/**
 * 既定レアリティ名（common / rare / ...）。#1783 のスタイル対象はカスタム
 * レアリティのみで、既定レアリティはビルトインの表示を維持する。
 * validateCustomRaritiesInput がカスタム名と既定名の衝突を禁じているのと同じ境界。
 */
const DEFAULT_RARITY_VALUES = new Set<string>(RARITIES.map((rarity) => rarity.value));

export function isAllowedColorValue(value: string): boolean {
  return HEX_COLOR_REGEX.test(value);
}

export function isAllowedGradientValue(value: string): boolean {
  // HEX ペア: "#RRGGBB,#RRGGBB" 形式のみ（from/to の両方が必要）。
  const parts = value.split(",");
  return parts.length === 2 && parts.every((p) => HEX_COLOR_REGEX.test(p.trim()));
}

export function isAllowedGlowValue(value: string): boolean {
  return HEX_COLOR_REGEX.test(value);
}

export function isAllowedEffectValue(value: string): boolean {
  if (value.length < 1 || value.length > MAX_EFFECT_NAME_LENGTH) return false;
  // 制御文字/Bidi override を禁止
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) return false;
  if (/[\u202A-\u202E\u2066-\u2069]/.test(value)) return false;
  return true;
}

export interface RarityStylesValidation {
  ok: true;
  value: RarityStyles;
}

export interface RarityStylesValidationFailure {
  ok: false;
}

export type RarityStylesValidationResult = RarityStylesValidation | RarityStylesValidationFailure;

/**
 * rarity_styles 入力を検証する。
 *
 * - オブジェクトであること（配列は拒否）。
 * - キーはレアリティ名（1〜MAX_RARITY_KEY_LENGTH、制御文字/Bidi 禁止、既定レアリティ名は拒否）。
 * - 値は RarityStyle オブジェクト。未指定のプロパティは省略可。
 * - 各プロパティは許可形式のみ。
 * - キー数の上限は MAX_CUSTOM_RARITIES。
 * - allowedKeys を渡した場合、キーはその集合に含まれるものだけを許可する
 *   （＝「登録済みのカスタムレアリティ」への制限。渡さない場合は形式のみを検証する）。
 */
export function validateRarityStylesInput(
  value: unknown,
  allowedKeys?: string[],
): RarityStylesValidationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_RARITIES) {
    return { ok: false };
  }

  const normalized: RarityStyles = {};
  const seen = new Set<string>();

  for (const [rawKey, rawStyle] of entries) {
    const key = rawKey.trim().normalize("NFC");
    if (
      key.length < 1 ||
      key.length > MAX_RARITY_KEY_LENGTH ||
      /[\u0000-\u001F\u007F-\u009F]/.test(key) ||
      /[\u202A-\u202E\u2066-\u2069]/.test(key) ||
      DEFAULT_RARITY_VALUES.has(key) ||
      seen.has(key)
    ) {
      return { ok: false };
    }

    if (allowedKeys && !allowedKeys.includes(key)) {
      return { ok: false };
    }

    seen.add(key);

    if (!rawStyle || typeof rawStyle !== "object" || Array.isArray(rawStyle)) {
      return { ok: false };
    }

    const style = rawStyle as Record<string, unknown>;
    const normalizedStyle: RarityStyle = {};

    if (style.color !== undefined) {
      if (typeof style.color !== "string" || !isAllowedColorValue(style.color)) {
        return { ok: false };
      }
      normalizedStyle.color = style.color;
    }

    if (style.gradient !== undefined) {
      if (typeof style.gradient !== "string" || !isAllowedGradientValue(style.gradient)) {
        return { ok: false };
      }
      normalizedStyle.gradient = style.gradient;
    }

    if (style.glow !== undefined) {
      if (typeof style.glow !== "string" || !isAllowedGlowValue(style.glow)) {
        return { ok: false };
      }
      normalizedStyle.glow = style.glow;
    }

    if (style.effect !== undefined) {
      if (typeof style.effect !== "string" || !isAllowedEffectValue(style.effect)) {
        return { ok: false };
      }
      normalizedStyle.effect = style.effect;
    }

    // 少なくとも1つのプロパティが必要
    if (Object.keys(normalizedStyle).length === 0) {
      return { ok: false };
    }

    normalized[key] = normalizedStyle;
  }

  return { ok: true, value: normalized };
}
