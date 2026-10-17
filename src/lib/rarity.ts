import {
  RARITIES,
  RARITY_COLORS,
  RARITY_GLOW,
  RARITY_GRADIENT_COLORS,
  RARITY_ORDER,
} from "./constants";
import {
  isAllowedColorValue,
  isAllowedGlowValue,
  isAllowedGradientValue,
  type RarityStyle,
  type RarityStyles,
} from "./rarity-styles";
// React 18 の型では CSSProperties にカスタムプロパティ用のインデックス署名が無い
// ため（実行時はサポートされる）、styleVars は CSSProperties として扱う。
// 型のみの import なのでサーバーコンポーネントから読んでも副作用はない。
import type { CSSProperties } from "react";

export type DefaultRarity = (typeof RARITIES)[number]["value"];

export const DEFAULT_RARITY_COLOR_CLASS = "bg-gray-500";
export const DEFAULT_RARITY_GRADIENT_CLASS = "from-gray-400 to-gray-600";
export const DEFAULT_RARITY_GLOW_CLASS = "shadow-gray-500/50";

/**
 * ビルトインのプリセット表から1件読み出す。
 *
 * `RARITY_COLORS[rarity]` のような通常のルックアップは、レアリティ名が
 * "constructor" / "toString" / "valueOf" 等のとき Object.prototype の継承プロパティ
 * （関数）を返してしまう。カスタムレアリティ名は任意の文字列を許容する
 * （validateCustomRaritiesInput が見るのは長さ・制御文字/Bidi・既定名との衝突だけ）
 * ため、必ず所有プロパティに限定して参照し、無ければフォールバックする。
 */
function readRarityPreset(
  map: Record<string, string>,
  rarity: string,
  fallback: string,
): string {
  return Object.prototype.hasOwnProperty.call(map, rarity) ? map[rarity] : fallback;
}

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

/**
 * レアリティのバッジ色クラス（または保存された色値）を返す。
 *
 * 注意（Issue #1783）: ここは `styles` の値をそのまま返す。値はフェーズ1の
 * rarity-styles.ts が「プリセット Tailwind クラス」と「HEX」の両形式を許可して
 * いるため、HEX を返すことがある。HEX を className に埋め込んでも色は付かないので、
 * カスタム色を実際に描画する経路では必ず getRarityStylePresentation（HEX を
 * CSS 変数 + var() 参照クラスへ変換する）を使うこと。
 */
export function getRarityColorClass(rarity: string, styles?: RarityStyles): string {
  const custom = styles?.[rarity]?.color;
  if (custom) return custom;
  return readRarityPreset(RARITY_COLORS, rarity, DEFAULT_RARITY_COLOR_CLASS);
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

export function getRarityGradientClass(rarity: string, styles?: RarityStyles): string {
  const custom = styles?.[rarity]?.gradient;
  // getRarityColorClass と同じ注意: HEX ペア（"#h,#h"）を返しうるため、実際に
  // 描画する経路では getRarityStylePresentation を使うこと。
  if (custom) return custom;
  return readRarityPreset(RARITY_GRADIENT_COLORS, rarity, DEFAULT_RARITY_GRADIENT_CLASS);
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

export function getRarityGlowClass(rarity: string, styles?: RarityStyles): string {
  const custom = styles?.[rarity]?.glow;
  // 同上: HEX を返しうるため、描画経路では getRarityStylePresentation を使うこと。
  if (custom) return custom;
  return readRarityPreset(RARITY_GLOW, rarity, DEFAULT_RARITY_GLOW_CLASS);
}

/* -------------------------------------------------------------------------- */
/* カスタムレアリティの表示スタイル                                            */
/* -------------------------------------------------------------------------- */

/**
 * 保存済みの色をインラインスタイルで当てるための CSS カスタムプロパティ名。
 *
 * なぜ CSS 変数経由にするか: Tailwind v4 はソース走査(JIT)でクラスを抽出するため、
 * `bg-[#rrggbb]` のように実行時に組み立てたクラス文字列は CSS に生成されない。
 * 一方 `bg-[color:var(--rarity-color)]` はソース上のリテラルとして走査対象になり、
 * 値そのものはインラインスタイルで差し込める。これにより「DB に入っている HEX を
 * そのまま描画する」ことをクラス生成に依存せず実現できる（Issue #1783）。
 */
export const RARITY_STYLE_CSS_VARS = {
  color: "--rarity-color",
  gradientFrom: "--rarity-gradient-from",
  gradientTo: "--rarity-gradient-to",
  glow: "--rarity-glow",
} as const;

/**
 * var() を参照する Tailwind クラス。**必ずリテラルとして書くこと。**
 *
 * 落とし穴（実測で確認済み）: Tailwind の走査はソーステキストの literal しか見ない。
 * `` `bg-[color:var(${RARITY_STYLE_CSS_VARS.color})]` `` のように変数展開で
 * 組み立てると、ソース上には `${...}` を含む断片しか無いため **CSS が生成されず、
 * 色が一切付かない**（ビルドは成功するので気付きにくい）。したがって
 * RARITY_STYLE_CSS_VARS の値と重複するが、ここは展開せず literal で持つ。
 * 同期は tests/unit/rarity-style-presentation.test.ts が両者の一致を検証する。
 */
export const RARITY_STYLE_VAR_CLASSES = {
  color: "bg-[color:var(--rarity-color)]",
  gradient:
    "from-[color:var(--rarity-gradient-from)] to-[color:var(--rarity-gradient-to)]",
  glow: "shadow-[color:var(--rarity-glow)]",
} as const;

/** style 属性へ展開する CSS カスタムプロパティの集合（未設定キーは含めない）。 */
export type RarityStyleVars = CSSProperties;

/**
 * レアリティ1件分の表示スタイル（クラス + インライン変数）。
 *
 * 「クラスだけ差し替えて変数を当て忘れる」「変数だけ当ててクラスが既定のまま」を
 * 構造的に防ぐため、必ず1組で返す。未設定レアリティでは従来のプリセットと
 * 完全に同じ出力になる（後方互換）。
 */
export interface RarityStylePresentation {
  /** バッジ等の背景色クラス。 */
  colorClass: string;
  /** グラデーションの from-/to- クラス。 */
  gradientClass: string;
  /** グロー（影色）クラス。 */
  glowClass: string;
  /** 対応するインライン CSS カスタムプロパティ（未設定時は空オブジェクト）。 */
  styleVars: RarityStyleVars;
}

/**
 * DB から読んだ1エントリを描画安全な形へ絞り込む。
 *
 * 保存時（POST /api/streamer/settings）にも rarity-styles.ts で同じ規則を検証して
 * いるが、JSONB は手編集・過去データ・部分破損を起こし得るため、描画側でも
 * 「不正値を弾く」のではなく「不正値を捨てる」。値は inline style の CSS カスタム
 * プロパティ / className として出力されるので、許可形式以外は一切通さない。
 * effect はこの描画層では未使用（オーバーレイのエフェクトは別 issue で扱う）ため
 * 読み出さない。
 */
function sanitizeRarityStyle(style: unknown): RarityStyle {
  if (!style || typeof style !== "object" || Array.isArray(style)) return {};
  const source = style as Record<string, unknown>;
  const safe: RarityStyle = {};
  if (typeof source.color === "string" && isAllowedColorValue(source.color)) {
    safe.color = source.color;
  }
  if (typeof source.gradient === "string" && isAllowedGradientValue(source.gradient)) {
    safe.gradient = source.gradient;
  }
  if (typeof source.glow === "string" && isAllowedGlowValue(source.glow)) {
    safe.glow = source.glow;
  }
  return safe;
}

/**
 * レアリティ名→表示スタイルマップから、そのレアリティの描画スタイルを解決する。
 *
 * - カスタムスタイルが無いレアリティは従来（プリセット）と完全に同じ出力。
 * - 値は「プリセット Tailwind クラス」と「HEX」の2形式を許容する
 *   （保存側 rarity-styles.ts の許可形式と同じ）。クラスはそのまま、HEX は
 *   CSS 変数 + var() 参照クラスに変換して当てる。
 * - グラデーションの HEX ペアは from/to が両方揃ったときだけ採用する。片方だけ
 *   だと中間色が壊れるため、不正値ではなく未設定扱いにしてプリセットへ戻す。
 */
export function getRarityStylePresentation(
  rarity: string,
  styles?: RarityStyles | null,
): RarityStylePresentation {
  // 通常のオブジェクトルックアップだと "__proto__" が Object.prototype を返すため、
  // 所有プロパティであることを明示してから読む。
  const custom =
    styles && typeof styles === "object" && !Array.isArray(styles)
      && Object.prototype.hasOwnProperty.call(styles, rarity)
      ? sanitizeRarityStyle(styles[rarity])
      : {};

  const vars: Record<string, string> = {};
  let colorClass = readRarityPreset(RARITY_COLORS, rarity, DEFAULT_RARITY_COLOR_CLASS);
  let gradientClass = readRarityPreset(
    RARITY_GRADIENT_COLORS,
    rarity,
    DEFAULT_RARITY_GRADIENT_CLASS,
  );
  let glowClass = readRarityPreset(RARITY_GLOW, rarity, DEFAULT_RARITY_GLOW_CLASS);

  if (custom.color) {
    if (custom.color.startsWith("#")) {
      vars[RARITY_STYLE_CSS_VARS.color] = custom.color;
      colorClass = RARITY_STYLE_VAR_CLASSES.color;
    } else {
      colorClass = custom.color;
    }
  }

  if (custom.gradient) {
    if (custom.gradient.startsWith("#")) {
      const [from, to] = custom.gradient.split(",").map((part) => part.trim());
      if (from && to) {
        vars[RARITY_STYLE_CSS_VARS.gradientFrom] = from;
        vars[RARITY_STYLE_CSS_VARS.gradientTo] = to;
        gradientClass = RARITY_STYLE_VAR_CLASSES.gradient;
      }
    } else {
      gradientClass = custom.gradient;
    }
  }

  if (custom.glow) {
    if (custom.glow.startsWith("#")) {
      vars[RARITY_STYLE_CSS_VARS.glow] = custom.glow;
      glowClass = RARITY_STYLE_VAR_CLASSES.glow;
    } else {
      glowClass = custom.glow;
    }
  }

  return { colorClass, gradientClass, glowClass, styleVars: vars as RarityStyleVars };
}
