// Issue #1783: カスタムレアリティの表示スタイル（文字色/バッジ色/グラデーション/
// グロー/エフェクト）を配信者ごとに永続化するための型と検証ヘルパ。
//
// 永続化・描画する色は **HEX**（#RGB / #RRGGBB / #RRGGBBAA）に統一する。
// 任意 CSS/HTML は通さない（インジェクション対策）。
//
// 互換性（レビュー指摘への対応）: フェーズ1 の API はプリセットの Tailwind クラス
// （bg-red-500 / "from-red-500 to-blue-600" / shadow-purple-500/50 等）も受理していた。
// Tailwind v4 はソース走査(JIT)でしかクラスを生成しないため、DBに入ったクラス名は
// 生成CSSに存在せず「200で保存できたのに無色」になる（実測: 許可集合のうち
// bg 57/198・from 13/198・to 13/198・shadow 5/594 しか生成されない）。全組み合わせの
// safelist は生成CSSが +303KB 増えるため採用せず、**従来形式を受理したうえで
// 安全な HEX へ正規化**する。正規化先は Tailwind の theme.css から生成した対応表
// （src/lib/tailwind-palette.ts）なので、同名クラスの実際の描画色とズレない。
// 正規化は保存時（このファイル）と描画時（rarity.ts）の両方で行うため、既に
// クラス形式で保存されている行も描画できる。

import { MAX_RARITY_KEY_LENGTH, MAX_CUSTOM_RARITIES, RARITIES } from "@/lib/constants";
import { TAILWIND_PALETTE_HEX } from "@/lib/tailwind-palette";

export interface RarityStyle {
  /** バッジ/文字色。HEX（#RGB / #RRGGBB / #RRGGBBAA）。 */
  color?: string;
  /** グラデーション。HEX ペア（`#RRGGBB,#RRGGBB`）。 */
  gradient?: string;
  /** グロー。HEX（不透明度は 8 桁 `#RRGGBBAA` で表現する）。 */
  glow?: string;
  /** エフェクトテンプレート名。 */
  effect?: string;
}

export type RarityStyles = Record<string, RarityStyle>;

// 許可する HEX 色形式。8 桁は legacy のグロー不透明度（shadow-…/25|50|75）を
// 正規化した結果を保持するために必要（4 桁は受け付けない）。
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// --- フェーズ1（legacy）のプリセット形式。互換のため受理し、HEX へ正規化する ---
// bg-{hue}-{shade}
const PRESET_BADGE_PATTERN = /^bg-([a-z]+)-([0-9]{2,3})$/;
// "from-{hue}-{shade} to-{hue}-{shade}"
const PRESET_GRADIENT_PATTERN = /^from-([a-z]+)-([0-9]{2,3})\s+to-([a-z]+)-([0-9]{2,3})$/;
// shadow-{hue}-{shade}[/25|/50|/75]
const PRESET_GLOW_PATTERN = /^shadow-([a-z]+)-([0-9]{2,3})(?:\/(25|50|75))?$/;
// legacy の不透明度指定を HEX8 のアルファ値へ（25%→0x40 / 50%→0x80 / 75%→0xbf）。
const GLOW_ALPHA_HEX: Readonly<Record<string, string>> = {
  "25": "40",
  "50": "80",
  "75": "bf",
};

/** パレット対応表の参照（未知の色名・シェード、プロトタイプ鎖は拾わない）。 */
function paletteHex(hue: string, shade: string): string | null {
  const key = `${hue}-${shade}`;
  return Object.prototype.hasOwnProperty.call(TAILWIND_PALETTE_HEX, key)
    ? TAILWIND_PALETTE_HEX[key]
    : null;
}

const MAX_EFFECT_NAME_LENGTH = 40;

/**
 * 既定レアリティ名（common / rare / ...）。#1783 のスタイル対象はカスタム
 * レアリティのみで、既定レアリティはビルトインの表示を維持する。
 * validateCustomRaritiesInput がカスタム名と既定名の衝突を禁じているのと同じ境界。
 */
const DEFAULT_RARITY_VALUES = new Set<string>(RARITIES.map((rarity) => rarity.value));

/**
 * バッジ色を「保存・描画できる色値」へ正規化する。受理できない場合は null。
 *
 * - HEX はそのまま返す。
 * - フェーズ1 のプリセット形式（`bg-red-500`）は対応表の HEX へ変換する。
 * - 未知の色名・シェード、任意 CSS（url()・式・プロパティ注入）は null。
 */
export function normalizeColorValue(value: string): string | null {
  if (HEX_COLOR_REGEX.test(value)) return value;
  const preset = PRESET_BADGE_PATTERN.exec(value);
  if (!preset) return null;
  return paletteHex(preset[1], preset[2]);
}

/**
 * グラデーションを正規化する。受理できない場合は null。
 *
 * - HEX ペア `"#rrggbb,#rrggbb"` は前後空白を落として `"#rrggbb,#rrggbb"` に揃える。
 * - フェーズ1 のプリセット形式 `"from-red-500 to-blue-600"` は HEX ペアへ変換する。
 */
export function normalizeGradientValue(value: string): string | null {
  const parts = value.split(",");
  if (parts.length === 2) {
    const from = parts[0].trim();
    const to = parts[1].trim();
    if (HEX_COLOR_REGEX.test(from) && HEX_COLOR_REGEX.test(to)) return `${from},${to}`;
  }
  const preset = PRESET_GRADIENT_PATTERN.exec(value.trim());
  if (!preset) return null;
  const from = paletteHex(preset[1], preset[2]);
  const to = paletteHex(preset[3], preset[4]);
  return from && to ? `${from},${to}` : null;
}

/**
 * グローを正規化する。受理できない場合は null。
 *
 * - HEX（#RGB / #RRGGBB / #RRGGBBAA）はそのまま返す。
 * - フェーズ1 のプリセット形式 `shadow-purple-500/50` は HEX8（アルファ付き）へ変換する。
 *   不透明度が無い `shadow-purple-500` は HEX のまま。
 */
export function normalizeGlowValue(value: string): string | null {
  if (HEX_COLOR_REGEX.test(value)) return value;
  const preset = PRESET_GLOW_PATTERN.exec(value);
  if (!preset) return null;
  const base = paletteHex(preset[1], preset[2]);
  if (!base) return null;
  const alpha = preset[3] ? GLOW_ALPHA_HEX[preset[3]] : undefined;
  return alpha ? `${base}${alpha}` : base;
}

/** バッジ色として受理できるか（正規化できるか）。 */
export function isAllowedColorValue(value: string): boolean {
  return normalizeColorValue(value) !== null;
}

/** グラデーションとして受理できるか（正規化できるか）。 */
export function isAllowedGradientValue(value: string): boolean {
  return normalizeGradientValue(value) !== null;
}

/** グローとして受理できるか（正規化できるか）。 */
export function isAllowedGlowValue(value: string): boolean {
  return normalizeGlowValue(value) !== null;
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
      const color = typeof style.color === "string" ? normalizeColorValue(style.color) : null;
      if (!color) {
        return { ok: false };
      }
      normalizedStyle.color = color;
    }

    if (style.gradient !== undefined) {
      const gradient =
        typeof style.gradient === "string" ? normalizeGradientValue(style.gradient) : null;
      if (!gradient) {
        return { ok: false };
      }
      normalizedStyle.gradient = gradient;
    }

    if (style.glow !== undefined) {
      const glow = typeof style.glow === "string" ? normalizeGlowValue(style.glow) : null;
      if (!glow) {
        return { ok: false };
      }
      normalizedStyle.glow = glow;
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
