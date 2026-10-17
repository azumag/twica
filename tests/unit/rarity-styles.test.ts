import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_RARITIES, MAX_RARITY_KEY_LENGTH } from "@/lib/constants";
import {
  isAllowedColorValue,
  isAllowedEffectValue,
  isAllowedGlowValue,
  isAllowedGradientValue,
  validateRarityStylesInput,
} from "@/lib/rarity-styles";

// Issue #1783: カスタムレアリティの表示スタイル検証。
// 色はインジェクション対策として HEX のみを許可し、任意 CSS/HTML（url()・式・
// プロパティ注入）を通さないことを固定する。
//
// フェーズ1ではプリセットの Tailwind クラス（bg-red-500 等）も許可していたが、
// Tailwind v4 はソース走査でしかクラスを生成しないため、DBに入ったクラス名は
// 生成CSSに存在せず「受理したのに無色」になる。許可集合の全組み合わせを
// safelist すると生成CSSが +303KB 増えるため、受理形式を HEX に限定した
// （描画は rarity.ts の getRarityStylePresentation が CSS 変数経由で行う）。
describe("rarity-styles validation", () => {
  describe("isAllowedColorValue", () => {
    it("accepts HEX (#RGB / #RRGGBB)", () => {
      expect(isAllowedColorValue("#fff")).toBe(true);
      expect(isAllowedColorValue("#FF00aa")).toBe(true);
    });

    it("rejects Tailwind classes, arbitrary CSS and non-color text", () => {
      // クラス形式は描画できない（Tailwind のソース走査に載らない）ため受理しない。
      expect(isAllowedColorValue("bg-red-500")).toBe(false);
      expect(isAllowedColorValue("bg-gray-950")).toBe(false);
      expect(isAllowedColorValue("#12345")).toBe(false);
      expect(isAllowedColorValue("#gggggg")).toBe(false);
      expect(isAllowedColorValue("red")).toBe(false);
      expect(isAllowedColorValue("url(https://example.com/x.png)")).toBe(false);
      expect(isAllowedColorValue("bg-red-500;background:url(x)")).toBe(false);
    });
  });

  describe("isAllowedGradientValue", () => {
    it("accepts HEX pairs", () => {
      expect(isAllowedGradientValue("#ff0000,#00ff00")).toBe(true);
      expect(isAllowedGradientValue("#ff0000, #00ff00")).toBe(true);
      expect(isAllowedGradientValue("#f00,#0f0")).toBe(true);
    });

    it("rejects gradient classes, partial gradients and non-pair HEX lists", () => {
      expect(isAllowedGradientValue("from-red-500 to-blue-600")).toBe(false);
      expect(isAllowedGradientValue("from-red-500")).toBe(false);
      expect(isAllowedGradientValue("#ff0000")).toBe(false);
      expect(isAllowedGradientValue("#ff0000,#00ff00,#0000ff")).toBe(false);
      expect(isAllowedGradientValue("red,blue")).toBe(false);
    });
  });

  describe("isAllowedGlowValue", () => {
    it("accepts HEX", () => {
      expect(isAllowedGlowValue("#ff0000")).toBe(true);
      expect(isAllowedGlowValue("#f00")).toBe(true);
    });

    it("rejects shadow classes and free-form shadows", () => {
      expect(isAllowedGlowValue("shadow-red-500/50")).toBe(false);
      expect(isAllowedGlowValue("0 0 10px red")).toBe(false);
    });
  });

  describe("isAllowedEffectValue", () => {
    it("accepts a plain effect name and rejects control/Bidi characters", () => {
      expect(isAllowedEffectValue("sparkle")).toBe(true);
      expect(isAllowedEffectValue("")).toBe(false);
      expect(isAllowedEffectValue("a".repeat(41))).toBe(false);
      expect(isAllowedEffectValue("spark\u0000le")).toBe(false);
      expect(isAllowedEffectValue("spark\u202Ele")).toBe(false);
    });
  });

  describe("validateRarityStylesInput", () => {
    it("normalizes keys and keeps only the allowed properties", () => {
      const result = validateRarityStylesInput({
        " 超激レア ": { color: "#ff0000", gradient: "#ff0000,#00ff00" },
        mythic: { glow: "#a855f7" },
      });

      expect(result).toEqual({
        ok: true,
        value: {
          超激レア: { color: "#ff0000", gradient: "#ff0000,#00ff00" },
          mythic: { glow: "#a855f7" },
        },
      });
    });

    it("accepts an empty map (no overrides)", () => {
      expect(validateRarityStylesInput({})).toEqual({ ok: true, value: {} });
    });

    it("rejects non-objects and arrays", () => {
      expect(validateRarityStylesInput(null)).toEqual({ ok: false });
      expect(validateRarityStylesInput("mythic")).toEqual({ ok: false });
      expect(validateRarityStylesInput([])).toEqual({ ok: false });
      expect(validateRarityStylesInput([{ color: "#ff0000" }])).toEqual({ ok: false });
    });

    it("rejects keys outside allowedKeys (未登録のレアリティへの指定)", () => {
      expect(
        validateRarityStylesInput({ mythic: { color: "#ff0000" } }, ["超激レア"]),
      ).toEqual({ ok: false });
      expect(
        validateRarityStylesInput({ 超激レア: { color: "#ff0000" } }, ["超激レア"]),
      ).toEqual({ ok: true, value: { 超激レア: { color: "#ff0000" } } });
    });

    it("rejects empty styles, unknown properties and invalid values", () => {
      expect(validateRarityStylesInput({ mythic: {} })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: { color: "red" } })).toEqual({ ok: false });
      // クラス形式は描画できないため 400 で拒否する（受理したのに無色、を作らない）。
      expect(validateRarityStylesInput({ mythic: { color: "bg-red-500" } })).toEqual({
        ok: false,
      });
      expect(validateRarityStylesInput({ mythic: { gradient: "red" } })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: { gradient: "from-red-500 to-blue-600" } })).toEqual({
        ok: false,
      });
      expect(validateRarityStylesInput({ mythic: { glow: "red" } })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: { glow: "shadow-red-500/50" } })).toEqual({
        ok: false,
      });
      expect(validateRarityStylesInput({ mythic: { effect: "a\u202Eb" } })).toEqual({ ok: false });
      // 未知プロパティだけのスタイルは「有効なプロパティ 0 件」として拒否する。
      expect(validateRarityStylesInput({ mythic: { fontSize: "900px" } })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: 5 })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: [] })).toEqual({ ok: false });
    });

    it("rejects invalid keys (空・長すぎ・制御文字・Bidi・既定レアリティ名・重複)", () => {
      expect(validateRarityStylesInput({ "": { color: "#ff0000" } })).toEqual({ ok: false });
      // 既定レアリティはビルトイン表示を維持する（#1783 のスタイル対象はカスタムのみ）。
      expect(validateRarityStylesInput({ legendary: { color: "#ff0000" } })).toEqual({
        ok: false,
      });
      expect(
        validateRarityStylesInput({ legendary: { color: "#ff0000" } }, ["legendary"]),
      ).toEqual({ ok: false });
      expect(
        validateRarityStylesInput({
          ["a".repeat(MAX_RARITY_KEY_LENGTH + 1)]: { color: "#ff0000" },
        }),
      ).toEqual({ ok: false });
      expect(validateRarityStylesInput({ "my\u0000thic": { color: "#ff0000" } })).toEqual({
        ok: false,
      });
      expect(validateRarityStylesInput({ "my\u202Ethic": { color: "#ff0000" } })).toEqual({
        ok: false,
      });
      // トリム後に同名になるキーは重複として拒否する（後勝ちで黙って潰さない）。
      expect(
        validateRarityStylesInput({
          mythic: { color: "#ff0000" },
          " mythic ": { color: "#00ff00" },
        }),
      ).toEqual({ ok: false });
    });

    it("rejects more entries than MAX_CUSTOM_RARITIES", () => {
      const tooMany: Record<string, { color: string }> = {};
      for (let index = 0; index <= MAX_CUSTOM_RARITIES; index += 1) {
        tooMany[`rarity-${index}`] = { color: "#ff0000" };
      }
      expect(validateRarityStylesInput(tooMany)).toEqual({ ok: false });
    });
  });
});
