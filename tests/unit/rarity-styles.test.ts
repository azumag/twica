import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_RARITIES, MAX_RARITY_KEY_LENGTH } from "@/lib/constants";
import {
  isAllowedColorValue,
  isAllowedEffectValue,
  isAllowedGlowValue,
  isAllowedGradientValue,
  normalizeColorValue,
  normalizeGlowValue,
  normalizeGradientValue,
  validateRarityStylesInput,
} from "@/lib/rarity-styles";

// Issue #1783: カスタムレアリティの表示スタイル検証。
// 任意 CSS/HTML（url()・式・プロパティ注入）を通さないことを固定する。
//
// 永続化する色は HEX に統一するが、フェーズ1 の API が受理していたプリセット
// Tailwind クラス（bg-red-500 等）は**互換のため受理し、HEX へ正規化**する。
// （Tailwind v4 はソース走査でしかクラスを生成しないため、クラス名のまま保存すると
//  無色になる。safelist は +303KB なので採用しない。）正規化先は
// src/lib/tailwind-palette.ts（Tailwind の theme.css から生成）を使う。
describe("rarity-styles validation", () => {
  describe("isAllowedColorValue / normalizeColorValue", () => {
    it("accepts HEX (#RGB / #RRGGBB) and keeps it as-is", () => {
      expect(isAllowedColorValue("#fff")).toBe(true);
      expect(isAllowedColorValue("#FF00aa")).toBe(true);
      expect(normalizeColorValue("#FF00aa")).toBe("#FF00aa");
    });

    it("normalizes legacy preset classes to HEX", () => {
      // フェーズ1 の許可集合（18 色 × 11 シェード）を HEX へ変換して受理する。
      expect(isAllowedColorValue("bg-red-500")).toBe(true);
      expect(normalizeColorValue("bg-red-500")).toBe("#fb2c36");
      expect(normalizeColorValue("bg-gray-950")).toBe("#030712");
      expect(normalizeColorValue("bg-lime-500")).toBe("#7ccf00");
    });

    it("rejects unknown hues/shades, arbitrary CSS and non-color text", () => {
      // slate はフェーズ1 の許可集合に無い。
      expect(isAllowedColorValue("bg-slate-500")).toBe(false);
      expect(isAllowedColorValue("bg-red-1000")).toBe(false);
      expect(isAllowedColorValue("#12345")).toBe(false);
      expect(isAllowedColorValue("#ffff")).toBe(false);
      // 8 桁はグロー専用（<input type="color"> が表現できないため色には使わない）。
      expect(isAllowedColorValue("#ff000080")).toBe(false);
      expect(isAllowedColorValue("#gggggg")).toBe(false);
      expect(isAllowedColorValue("red")).toBe(false);
      expect(isAllowedColorValue("url(https://example.com/x.png)")).toBe(false);
      expect(isAllowedColorValue("bg-red-500;background:url(x)")).toBe(false);
      expect(normalizeColorValue("bg-slate-500")).toBeNull();
      // プロトタイプ鎖の名前を色名として引かない（paletteHex の hasOwnProperty 保護）。
      expect(isAllowedColorValue("bg-constructor-500")).toBe(false);
      expect(isAllowedColorValue("bg-toString-500")).toBe(false);
      expect(isAllowedColorValue("bg-hasOwnProperty-500")).toBe(false);
    });
  });

  describe("isAllowedGradientValue / normalizeGradientValue", () => {
    it("accepts HEX pairs and canonicalizes the separator", () => {
      expect(isAllowedGradientValue("#ff0000,#00ff00")).toBe(true);
      expect(isAllowedGradientValue("#ff0000, #00ff00")).toBe(true);
      expect(isAllowedGradientValue("#f00,#0f0")).toBe(true);
      expect(normalizeGradientValue("#ff0000, #00ff00")).toBe("#ff0000,#00ff00");
    });

    it("normalizes the legacy preset gradient form to a HEX pair", () => {
      expect(isAllowedGradientValue("from-red-500 to-blue-600")).toBe(true);
      expect(normalizeGradientValue("from-red-500 to-blue-600")).toBe("#fb2c36,#155dfc");
    });

    it("rejects partial gradients, unknown presets and non-pair HEX lists", () => {
      expect(isAllowedGradientValue("from-red-500")).toBe(false);
      expect(isAllowedGradientValue("from-slate-500 to-blue-600")).toBe(false);
      expect(isAllowedGradientValue("#ff0000")).toBe(false);
      expect(isAllowedGradientValue("#ff0000,#00ff00,#0000ff")).toBe(false);
      expect(isAllowedGradientValue("red,blue")).toBe(false);
    });
  });

  describe("isAllowedGlowValue / normalizeGlowValue", () => {
    it("accepts HEX (including 8-digit for opacity)", () => {
      expect(isAllowedGlowValue("#ff0000")).toBe(true);
      expect(isAllowedGlowValue("#f00")).toBe(true);
      expect(isAllowedGlowValue("#ff000080")).toBe(true);
      expect(normalizeGlowValue("#ff000080")).toBe("#ff000080");
    });

    it("normalizes legacy shadow classes, mapping opacity to HEX8 alpha", () => {
      expect(normalizeGlowValue("shadow-red-500")).toBe("#fb2c36");
      expect(normalizeGlowValue("shadow-red-500/25")).toBe("#fb2c3640");
      expect(normalizeGlowValue("shadow-red-500/50")).toBe("#fb2c3680");
      expect(normalizeGlowValue("shadow-red-500/75")).toBe("#fb2c36bf");
    });

    it("rejects unknown opacity steps, unknown presets and free-form shadows", () => {
      expect(isAllowedGlowValue("shadow-red-500/33")).toBe(false);
      expect(isAllowedGlowValue("shadow-slate-500/50")).toBe(false);
      expect(isAllowedGlowValue("0 0 10px red")).toBe(false);
      expect(isAllowedGlowValue("#ffff")).toBe(false);
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

    it("normalizes legacy preset inputs to HEX on save (互換)", () => {
      // フェーズ1 の API が受理していたクラス形式を、保存時に HEX へ正規化する。
      // これにより「受理したのに描画できない値」が永続化されない。
      expect(
        validateRarityStylesInput({
          mythic: {
            color: "bg-red-500",
            gradient: "from-red-500 to-blue-600",
            glow: "shadow-purple-500/50",
          },
        }),
      ).toEqual({
        ok: true,
        value: {
          mythic: { color: "#fb2c36", gradient: "#fb2c36,#155dfc", glow: "#ad46ff80" },
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

    it("rejects empty styles, invalid values, and drops unknown properties", () => {
      expect(validateRarityStylesInput({ mythic: {} })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: { color: "red" } })).toEqual({ ok: false });
      // 未知の色名・シェードは拒否する（フェーズ1 の許可集合に無いもの）。
      expect(validateRarityStylesInput({ mythic: { color: "bg-slate-500" } })).toEqual({
        ok: false,
      });
      expect(validateRarityStylesInput({ mythic: { gradient: "red" } })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: { glow: "red" } })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: { glow: "shadow-red-500/33" } })).toEqual({
        ok: false,
      });
      expect(validateRarityStylesInput({ mythic: { effect: "a\u202Eb" } })).toEqual({ ok: false });
      // 未知プロパティだけのスタイルは「有効なプロパティ 0 件」として拒否する。
      expect(validateRarityStylesInput({ mythic: { fontSize: "900px" } })).toEqual({ ok: false });
      // 有効なプロパティが併存する場合、未知プロパティは黙って捨てる（従来からの挙動）。
      expect(validateRarityStylesInput({ mythic: { color: "#ff0000", fontSize: "900px" } })).toEqual({
        ok: true,
        value: { mythic: { color: "#ff0000" } },
      });
      expect(validateRarityStylesInput({ mythic: 5 })).toEqual({ ok: false });
      expect(validateRarityStylesInput({ mythic: [] })).toEqual({ ok: false });
    });

    it("rejects only __proto__ (プロトタイプ setter で黙って消えるキー)", () => {
      // JSON.parse で作った own プロパティ "__proto__" も明示的に拒否する。
      expect(
        validateRarityStylesInput(JSON.parse('{"__proto__":{"color":"#ff0000"}}')),
      ).toEqual({ ok: false });
      // グローバル汚染が無いことも固定する。
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("accepts constructor / prototype as rarity names (画面側が許可している既存名)", () => {
      // validateCustomRaritiesInput はこの2つをカスタムレアリティ名として許可する。
      // 代入は通常の own プロパティを作るだけで、JSON にもそのまま載る。
      // ここで拒否すると「名前は登録できるのに色を設定すると編集全体が 400 になる」。
      expect(
        validateRarityStylesInput({ constructor: { color: "#ff0000" } }),
      ).toEqual({ ok: true, value: { constructor: { color: "#ff0000" } } });
      expect(validateRarityStylesInput({ prototype: { color: "#00ff00" } })).toEqual({
        ok: true,
        value: { prototype: { color: "#00ff00" } },
      });

      const result = validateRarityStylesInput({
        constructor: { color: "#ff0000" },
        prototype: { color: "#00ff00" },
      });
      expect(result.ok).toBe(true);
      // JSON ラウンドトリップでも own プロパティとして残る。
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        ok: true,
        value: { constructor: { color: "#ff0000" }, prototype: { color: "#00ff00" } },
      });
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
