import { describe, expect, it } from "vitest";
import {
  formatRarityLabel,
  getRarityColorClass,
  getRarityGlowClass,
  getRarityGradientClass,
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
});
