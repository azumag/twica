// Issue #1783: カスタムレアリティの表示スタイル（文字色/バッジ色/グラデーション/
// グロー/エフェクト）を配信者ごとに永続化するための型と検証ヘルパ。
//
// 色はインジェクション対策のため HEX (#RGB / #RRGGBB) またはプリセットの
// Tailwind クラスのみを許可する。任意 CSS/HTML は通さない。

import { MAX_RARITY_KEY_LENGTH, MAX_CUSTOM_RARITIES } from "@/lib/constants";

export interface RarityStyle {
  /** バッジ/文字色。HEX (#RGB/#RRGGBB) または Tailwind プリセットクラス。 */
  color?: string;
  /** グラデーション。Tailwind の `from-X to-Y` 形式または HEX ペア。 */
  gradient?: string;
  /** グロー。Tailwind の `shadow-X` 形式または HEX。 */
  glow?: string;
  /** エフェクトテンプレート名。 */
  effect?: string;
}

export type RarityStyles = Record<string, RarityStyle>;

// 許可する HEX 色形式。
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// 許可するプリセット Tailwind クラス（色名 + シェード）。
// 既存の RARITY_COLORS / RARITY_GRADIENT_COLORS / RARITY_GLOW の値を基準に、
// 一般的な Tailwind 色名・シェードを許可する。
const TAILWIND_COLOR_NAMES = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia",
  "pink", "rose",
];
const TAILWIND_SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

// プリセットのバッジ色クラス: bg-{color}-{shade}
const PRESET_BADGE_COLOR_REGEX = new RegExp(
  `^bg-(${TAILWIND_COLOR_NAMES.join("|")})-(${TAILWIND_SHADES.join("|")})$`
);
// プリセットのグラデーションクラス: from-{color}-{shade} to-{color}-{shade}
const PRESET_GRADIENT_REGEX = new RegExp(
  `^from-(${TAILWIND_COLOR_NAMES.join("|")})-(${TAILWIND_SHADES.join("|")}) to-(${TAILWIND_COLOR_NAMES.join("|")})-(${TAILWIND_SHADES.join("|")})$`
);
// プリセットのグロークラス: shadow-{color}-{shade}/50 (or /25, /75)
const PRESET_GLOW_REGEX = new RegExp(
  `^shadow-(${TAILWIND_COLOR_NAMES.join("|")})-(${TAILWIND_SHADES.join("|")})(\\/(25|50|75))?$`
);

const MAX_EFFECT_NAME_LENGTH = 40;

export function isAllowedColorValue(value: string): boolean {
  if (HEX_COLOR_REGEX.test(value)) return true;
  if (PRESET_BADGE_COLOR_REGEX.test(value)) return true;
  return false;
}

export function isAllowedGradientValue(value: string): boolean {
  if (PRESET_GRADIENT_REGEX.test(value)) return true;
  // HEX ペア: "#RRGGBB,#RRGGBB" 形式
  const parts = value.split(",");
  if (parts.length === 2 && parts.every((p) => HEX_COLOR_REGEX.test(p.trim()))) return true;
  return false;
}

export function isAllowedGlowValue(value: string): boolean {
  if (PRESET_GLOW_REGEX.test(value)) return true;
  if (HEX_COLOR_REGEX.test(value)) return true;
  return false;
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
 * - キーはレアリティ名（1〜MAX_RARITY_KEY_LENGTH、制御文字/Bidi 禁止）。
 * - 値は RarityStyle オブジェクト。未指定のプロパティは省略可。
 * - 各プロパティは許可形式のみ。
 * - キー数の上限は MAX_CUSTOM_RARITIES。
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
