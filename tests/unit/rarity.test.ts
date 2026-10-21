import { describe, expect, it } from "vitest";
import {
  formatRarityLabel,
  getRarityColorClass,
  getRarityGlowClass,
  getRarityGradientClass,
  getRarityDisplayInfo,
  aggregateCustomRarities,
  getRarityRank,
  compareByRarity,
} from "@/lib/rarity";

describe("rarity helpers", () => {
  it("translates default rarities and preserves custom labels", () => {
    const translate = (key: "common" | "rare" | "epic" | "legendary") => `t:${key}`;

    expect(formatRarityLabel("legendary", translate)).toBe("t:legendary");
    expect(formatRarityLabel("mythic", translate)).toBe("mythic");
  });

  it("falls back to common visual classes for custom rarities", () => {
    expect(getRarityColorClass("mythic")).toBe("bg-gray-500");
    expect(getRarityGradientClass("mythic")).toBe("from-gray-400 to-gray-600");
    expect(getRarityGlowClass("mythic")).toBe("shadow-gray-500/50");
  });

  describe("getRarityDisplayInfo", () => {
    it("returns the preset for default rarities", () => {
      expect(getRarityDisplayInfo("legendary")).toEqual({
        value: "legendary",
        label: "レジェンダリー",
        color: "bg-yellow-500",
      });
    });

    it("returns the raw name and fallback color for custom rarities", () => {
      expect(getRarityDisplayInfo("超激レア")).toEqual({
        value: "超激レア",
        label: "超激レア",
        color: "bg-gray-500",
      });
    });
  });

  describe("aggregateCustomRarities", () => {
    it("counts only custom rarities, sorted by name", () => {
      const cards = [
        { rarity: "common" },
        { rarity: "legendary" },
        { rarity: "super" },
        { rarity: "alpha" },
        { rarity: "super" },
      ];
      expect(aggregateCustomRarities(cards)).toEqual([
        { rarity: "alpha", count: 1 },
        { rarity: "super", count: 2 },
      ]);
    });

    it("returns an empty array when only default rarities are present", () => {
      expect(
        aggregateCustomRarities([{ rarity: "common" }, { rarity: "rare" }]),
      ).toEqual([]);
    });
  });

  describe("getRarityRank", () => {
    it("ranks builtin rarities from legendary (0) to common (3)", () => {
      expect(getRarityRank("legendary")).toBe(0);
      expect(getRarityRank("epic")).toBe(1);
      expect(getRarityRank("rare")).toBe(2);
      expect(getRarityRank("common")).toBe(3);
    });

    it("ranks unknown (custom) rarities after all builtin rarities (Issue #505)", () => {
      // 修正前は Array.prototype.indexOf の -1 をそのまま比較に使っており、
      // カスタムレアリティが legendary (0) より「小さい」と誤判定されて
      // 一覧の先頭に来てしまっていた。POSITIVE_INFINITY を返すことで
      // 常に最後尾に並ぶことを保証する。
      expect(getRarityRank("mythic")).toBe(Number.POSITIVE_INFINITY);
      expect(getRarityRank("mythic")).toBeGreaterThan(getRarityRank("common"));
    });
  });

  describe("compareByRarity", () => {
    it("sorts builtin rarities from legendary to common", () => {
      const cards = [
        { rarity: "common" },
        { rarity: "legendary" },
        { rarity: "rare" },
        { rarity: "epic" },
      ];

      expect(cards.sort(compareByRarity).map((c) => c.rarity)).toEqual([
        "legendary",
        "epic",
        "rare",
        "common",
      ]);
    });

    it("sorts a custom rarity after legendary, not before it (Issue #505)", () => {
      const cards = [
        { rarity: "mythic" },
        { rarity: "legendary" },
        { rarity: "common" },
      ];

      // 修正前は "mythic" (custom) が先頭 (legendaryより希少扱い) に来ていた
      expect(cards.sort(compareByRarity).map((c) => c.rarity)).toEqual([
        "legendary",
        "common",
        "mythic",
      ]);
    });
  });

  // Issue #1783 フェーズ2: 保存済みスタイルを描画する経路は
  // getRarityStylePresentation に一本化した。クラス専用のこれら3ヘルパは
  // プリセット専用で、styles 引数を持たない（HEX が className に混入する
  // footgun を残さないため）。
  describe("custom rarity style overrides (Issue #1783)", () => {
    it("returns the built-in presets and the shared fallback", () => {
      expect(getRarityColorClass("legendary")).toBe("bg-yellow-500");
      expect(getRarityGradientClass("legendary")).toBe("from-yellow-400 to-orange-500");
      expect(getRarityGlowClass("legendary")).toBe("shadow-yellow-500/50");
      // カスタムレアリティは色定義が無いため共有フォールバックへ倒す。
      expect(getRarityColorClass("mythic")).toBe("bg-gray-500");
      expect(getRarityGradientClass("mythic")).toBe("from-gray-400 to-gray-600");
      expect(getRarityGlowClass("mythic")).toBe("shadow-gray-500/50");
    });
  });
});
