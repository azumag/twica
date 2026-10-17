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

  // Issue #1783: 配信者が設定した表示スタイルは、既定マップより優先される。
  // 未設定（空マップ / 該当キー無し / プロパティ無し）は現行の既定表示を維持する。
  describe("custom rarity style overrides (Issue #1783)", () => {
    it("prefers the configured color / gradient / glow over the defaults", () => {
      const styles = {
        mythic: {
          color: "#ff0000",
          gradient: "from-red-500 to-blue-600",
          glow: "shadow-purple-500/50",
        },
      };

      expect(getRarityColorClass("mythic", styles)).toBe("#ff0000");
      expect(getRarityGradientClass("mythic", styles)).toBe("from-red-500 to-blue-600");
      expect(getRarityGlowClass("mythic", styles)).toBe("shadow-purple-500/50");
    });

    it("keeps the defaults when nothing is configured for the rarity", () => {
      expect(getRarityColorClass("mythic", {})).toBe("bg-gray-500");
      expect(getRarityColorClass("mythic", { other: { color: "#ff0000" } })).toBe("bg-gray-500");
      expect(getRarityGradientClass("mythic", { mythic: {} })).toBe("from-gray-400 to-gray-600");
      expect(getRarityGlowClass("mythic", { mythic: {} })).toBe("shadow-gray-500/50");
      // styles 未指定（列未デプロイのデプロイ窓を含む）でも従来どおり動く。
      expect(getRarityColorClass("legendary")).toBe("bg-yellow-500");
    });

    it("does not override built-in rarities unless a style is configured for them", () => {
      expect(getRarityColorClass("legendary", { mythic: { color: "#ff0000" } })).toBe(
        "bg-yellow-500",
      );
      expect(getRarityColorClass("legendary", { legendary: { color: "#ff0000" } })).toBe(
        "#ff0000",
      );
    });
  });
});
