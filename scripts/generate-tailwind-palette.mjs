#!/usr/bin/env node
/**
 * Tailwind v4 の既定パレット（`--color-{hue}-{shade}: oklch(...)`）を sRGB の HEX へ変換し、
 * `src/lib/tailwind-palette.ts` を生成する（Issue #1783 互換対応）。
 *
 * なぜ必要か: Issue #1783 フェーズ2 で rarity_styles の受理形式を HEX のみに絞ったが、
 * フェーズ1 の API はプリセット Tailwind クラス（`bg-red-500` 等）も受理していた。
 * 互換のため、その形式を「安全な色値（HEX）」へ正規化して受け入れる必要がある。
 * 正規化先の HEX は、アプリが実際に描画する Tailwind v4 のパレットと一致させる
 * （別バージョンの既知 HEX を手で書くと、同名クラスの実際の描画色とズレる）。
 *
 * なぜ OKLCH のまま保存しないか: オーバーレイは OBS(CEF) 上で動く。パレットの実体は
 * oklch() であり CEF のバージョンによっては解釈できない。オーバーレイ内の既存の演出色
 * （src/lib/overlay-effect.ts）も HEX リテラルで持っているため、それに揃える。
 *
 * 使い方:
 *   node scripts/generate-tailwind-palette.mjs            # src/lib/tailwind-palette.ts を上書き
 *   node scripts/generate-tailwind-palette.mjs --stdout   # 生成結果を標準出力（ドリフト検査用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** フェーズ1 の validator が許可していた色名（18 種）。slate/zinc/neutral/stone は含まない。 */
const HUES = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia",
  "pink", "rose",
];
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const themePath = path.join(repoRoot, "node_modules/tailwindcss/theme.css");
const outPath = path.join(repoRoot, "src/lib/tailwind-palette.ts");

/**
 * oklch(L% C H) → sRGB HEX。CSS Color 4（https://www.w3.org/TR/css-color-4/）の
 * 定義どおり、oklch → oklab → LMS → 線形 sRGB → sRGB の順に変換する。
 * sRGB の範囲外は 0..1 へクランプする（パレットは sRGB 内だが丸め誤差対策）。
 */
function oklchToHex(lPercent, chroma, hueDeg) {
  const L = lPercent / 100;
  const hRad = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hRad);
  const b = chroma * Math.sin(hRad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const linearR = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const linearG = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const linearB = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  // 線形 sRGB → sRGB（ガンマ）
  const encode = (c) => {
    const clamped = Math.min(1, Math.max(0, c));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, srgb)) * 255);
  };
  const toHex = (n) => n.toString(16).padStart(2, "0");

  return `#${toHex(encode(linearR))}${toHex(encode(linearG))}${toHex(encode(linearB))}`;
}

function readPalette() {
  const themeCss = fs.readFileSync(themePath, "utf8");
  const entries = [];
  for (const hue of HUES) {
    for (const shade of SHADES) {
      const name = `${hue}-${shade}`;
      const match = themeCss.match(new RegExp(`--color-${name}:\\s*oklch\\(([^)]+)\\)`));
      if (!match) {
        throw new Error(`theme.css に --color-${name} の oklch 定義が見つかりません`);
      }
      const [lPart, cPart, hPart] = match[1].trim().split(/\s+/);
      entries.push([name, oklchToHex(parseFloat(lPart), parseFloat(cPart), parseFloat(hPart))]);
    }
  }
  return entries;
}

function render(entries, version) {
  const body = entries
    .map(([name, hex]) => `  ${JSON.stringify(name)}: ${JSON.stringify(hex)},`)
    .join("\n");
  return `// Tailwind v4 の既定パレット（sRGB HEX）。**このファイルは自動生成です。手で編集しないこと。**
//
// 生成: node scripts/generate-tailwind-palette.mjs
// 入力: node_modules/tailwindcss/theme.css（tailwindcss@${version}）
// 用途: Issue #1783 でフェーズ1 が受理していたプリセット Tailwind クラス
//       （bg-{hue}-{shade} / from-… to-… / shadow-…[/25|50|75]）を、
//       保存・描画できる HEX へ正規化するための対応表。
//
// 値を手書きせず Tailwind の theme.css から生成しているのは、同名クラスの実際の
// 描画色（oklch）と正規化後の HEX がズレないようにするため。ドリフト検査は
// tests/unit/tailwind-palette.test.ts が --stdout 出力との突き合わせで行う。

/** パレット色の対応表（キーは \`{hue}-{shade}\`、値は \`#rrggbb\`）。 */
export const TAILWIND_PALETTE_HEX: Readonly<Record<string, string>> = {
${body}
};
`;
}

const version = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "node_modules/tailwindcss/package.json"), "utf8"),
).version;
const entries = readPalette();
const output = render(entries, version);

if (process.argv.includes("--stdout")) {
  process.stdout.write(output);
} else {
  fs.writeFileSync(outPath, output);
  console.log(`generated ${outPath}: ${entries.length} colors (tailwindcss@${version})`);
}
