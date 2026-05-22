import { describe, expect, it } from "vitest";
import {
  aggregateCustomRarities,
  formatRarityLabel,
  getRarityColorClass,
  getRarityDisplayInfo,
  getRarityGlowClass,
  getRarityGradientClass,
  isGuaranteedRarity,
  meetsRarityFloor,
  normalizeGuaranteedRarity,
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

  describe("guaranteed rarity helpers", () => {
    it("recognizes supported guaranteed rarity values", () => {
      expect(isGuaranteedRarity("rare")).toBe(true);
      expect(isGuaranteedRarity("epic")).toBe(true);
      expect(isGuaranteedRarity("legendary")).toBe(true);
      expect(isGuaranteedRarity("common")).toBe(false);
      expect(isGuaranteedRarity("custom")).toBe(false);
    });

    it("normalizes empty guaranteed rarity values to null", () => {
      expect(normalizeGuaranteedRarity(undefined)).toBeNull();
      expect(normalizeGuaranteedRarity(null)).toBeNull();
      expect(normalizeGuaranteedRarity("")).toBeNull();
      expect(normalizeGuaranteedRarity("rare")).toBe("rare");
      expect(normalizeGuaranteedRarity("common")).toBeNull();
    });

    it("checks built-in rarity floors while excluding custom rarity values", () => {
      expect(meetsRarityFloor("rare", "rare")).toBe(true);
      expect(meetsRarityFloor("epic", "rare")).toBe(true);
      expect(meetsRarityFloor("common", "rare")).toBe(false);
      expect(meetsRarityFloor("custom-ultra", "rare")).toBe(false);
    });
  });
});
