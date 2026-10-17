import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TAILWIND_PALETTE_HEX } from "@/lib/tailwind-palette";

// Issue #1783 互換対応: フェーズ1 が受理していたプリセット Tailwind クラスを
// HEX へ正規化するための対応表（src/lib/tailwind-palette.ts）の契約。
//
// このファイルは scripts/generate-tailwind-palette.mjs が
// node_modules/tailwindcss/theme.css から生成する。手書きの HEX を混ぜると
// 同名クラスの実際の描画色（oklch）とズレるため、生成物と theme.css の
// ドリフトをここで検出する。

// フェーズ1 の validator が許可していた色名（18 種）とシェード。
// slate/zinc/neutral/stone はフェーズ1 の許可集合に無いため対象外。
const HUES = [
  "gray", "red", "orange", "amber", "yellow", "lime", "green", "emerald",
  "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia",
  "pink", "rose",
];
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

const HEX_6 = /^#[0-9a-f]{6}$/;

describe("TAILWIND_PALETTE_HEX", () => {
  it("フェーズ1 の許可集合（18色 × 11シェード = 198）を過不足なく持つ", () => {
    const expected = HUES.flatMap((hue) => SHADES.map((shade) => `${hue}-${shade}`));
    expect(Object.keys(TAILWIND_PALETTE_HEX).sort()).toEqual(expected.sort());
  });

  it("全エントリが 6 桁の小文字 HEX である", () => {
    for (const [name, value] of Object.entries(TAILWIND_PALETTE_HEX)) {
      expect(`${name}=${value}`).toMatch(/^[a-z]+-\d{2,3}=#[0-9a-f]{6}$/);
      expect(HEX_6.test(value)).toBe(true);
    }
  });

  it("Tailwind v4 の oklch を sRGB へ換算した既知値と一致する（変換の妥当性）", () => {
    // Tailwind v4 は palette を oklch で定義しており sRGB HEX は公開していない。
    // ここで固定するのは「theme.css の oklch を CSS Color 4 の式で sRGB へ換算した値」で、
    // ブラウザ実装（Chrome/CEF）の実描画と 1/255 以内で一致することをレビューで実測済み。
    // v3 の既知 HEX とは一部異なる（v4 は oklch 基準でより鮮やか）ため、
    // 生成物が v3 値へ退行していないことも兼ねる。
    // 注: パレットの一部は sRGB ガマット外で、値は per-channel clip に依存する
    // （overlay のターゲットは CEF = Chrome なので clip 結果で問題ない）。
    expect(TAILWIND_PALETTE_HEX["red-500"]).toBe("#fb2c36");
    expect(TAILWIND_PALETTE_HEX["blue-500"]).toBe("#2b7fff");
    expect(TAILWIND_PALETTE_HEX["emerald-500"]).toBe("#00bc7d");
    expect(TAILWIND_PALETTE_HEX["amber-500"]).toBe("#fe9a00");
    expect(TAILWIND_PALETTE_HEX["purple-500"]).toBe("#ad46ff");
    expect(TAILWIND_PALETTE_HEX["gray-500"]).toBe("#6a7282");
    // v3 と同じ値になるもの（変換のアンカー）
    expect(TAILWIND_PALETTE_HEX["lime-50"]).toBe("#f7fee7");
    expect(TAILWIND_PALETTE_HEX["gray-50"]).toBe("#f9fafb");
  });

  it("theme.css とドリフトしていない（生成物が再生成結果と一致する）", () => {
    const cwd = process.cwd();
    const script = path.join(cwd, "scripts/generate-tailwind-palette.mjs");
    const regenerated = execFileSync(process.execPath, [script, "--stdout"], {
      cwd,
      encoding: "utf8",
    });
    const committed = fs.readFileSync(path.join(cwd, "src/lib/tailwind-palette.ts"), "utf8");
    // 差分があれば `node scripts/generate-tailwind-palette.mjs` で再生成すること。
    expect(committed).toBe(regenerated);
  });
});
