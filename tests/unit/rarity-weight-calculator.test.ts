import { describe, expect, it } from "vitest";
import { calculateDropRates } from "@/lib/rarity-weight-calculator";

describe("calculateDropRates", () => {
  it("calculates per-card drop rates from rarity percentages", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "c2", rarity: "common", is_active: true },
        { id: "r1", rarity: "rare", is_active: true },
        { id: "e1", rarity: "epic", is_active: true },
        { id: "l1", rarity: "legendary", is_active: true },
      ],
      { common: 50, rare: 30, epic: 15, legendary: 5 }
    );

    expect(result).toEqual([
      { id: "c1", dropRate: 0.25 },
      { id: "c2", dropRate: 0.25 },
      { id: "r1", dropRate: 0.3 },
      { id: "e1", dropRate: 0.15 },
      { id: "l1", dropRate: 0.05 },
    ]);
  });

  it("skips rarities with zero active cards", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "c2", rarity: "common", is_active: false },
        { id: "l1", rarity: "legendary", is_active: true },
      ],
      { common: 50, rare: 30, epic: 15, legendary: 5 }
    );

    expect(result).toEqual([
      { id: "c1", dropRate: 0.5 },
      { id: "l1", dropRate: 0.05 },
    ]);
  });

  it("uses fallback equal per-card weight for rarities missing in rarityWeights", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "m1", rarity: "mythic", is_active: true },
        { id: "m2", rarity: "mythic", is_active: true },
      ],
      { common: 60 }
    );

    expect(result).toEqual([
      { id: "c1", dropRate: 0.6 },
      { id: "m1", dropRate: 0.3333 },
      { id: "m2", dropRate: 0.3333 },
    ]);
  });

  it("rounds values to 4 decimals for DECIMAL(5,4)", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "c2", rarity: "common", is_active: true },
        { id: "c3", rarity: "common", is_active: true },
      ],
      { common: 50 }
    );

    expect(result).toEqual([
      { id: "c1", dropRate: 0.1667 },
      { id: "c2", dropRate: 0.1667 },
      { id: "c3", dropRate: 0.1667 },
    ]);
  });

  it("returns empty array when all cards are inactive", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: false },
        { id: "c2", rarity: "rare", is_active: false },
      ],
      { common: 50, rare: 30 }
    );

    expect(result).toEqual([]);
  });

  it("returns empty array for empty cards list", () => {
    const result = calculateDropRates([], { common: 50 });
    expect(result).toEqual([]);
  });

  it("uses fallback for NaN or Infinity weight values", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "c2", rarity: "rare", is_active: true },
      ],
      { common: NaN, rare: Infinity }
    );

    // NaN/Infinity は isValidPercent で弾かれ、fallbackPerCard (1/2 = 0.5) が使われる
    expect(result).toEqual([
      { id: "c1", dropRate: 0.5 },
      { id: "c2", dropRate: 0.5 },
    ]);
  });

  it("handles weights that sum to more than 100%", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "r1", rarity: "rare", is_active: true },
      ],
      { common: 80, rare: 80 }
    );

    // 合計160%でも各レアリティの計算は独立して行われる
    expect(result).toEqual([
      { id: "c1", dropRate: 0.8 },
      { id: "r1", dropRate: 0.8 },
    ]);
  });

  it("handles single active card correctly", () => {
    const result = calculateDropRates(
      [{ id: "c1", rarity: "legendary", is_active: true }],
      { common: 50, rare: 30, epic: 15, legendary: 5 }
    );

    // 1枚のlegendaryカード → そのレアリティの全重み(5%)がこのカードに
    expect(result).toEqual([{ id: "c1", dropRate: 0.05 }]);
  });

  it("uses fallback for all cards when rarityWeights is empty object", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "c2", rarity: "rare", is_active: true },
      ],
      {}
    );

    // 空オブジェクト → 全レアリティがfallback（均等配分 1/2 = 0.5）
    expect(result).toEqual([
      { id: "c1", dropRate: 0.5 },
      { id: "c2", dropRate: 0.5 },
    ]);
  });

  it("handles boundary values: 0% and 100%", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "r1", rarity: "rare", is_active: true },
      ],
      { common: 0, rare: 100 }
    );

    expect(result).toEqual([
      { id: "c1", dropRate: 0 },
      { id: "r1", dropRate: 1 },
    ]);
  });

  it("uses fallback for negative weight values", () => {
    const result = calculateDropRates(
      [{ id: "c1", rarity: "common", is_active: true }],
      { common: -5 }
    );

    // 負の値は isValidPercent で弾かれ、fallback (1/1 = 1.0) が使われる
    expect(result).toEqual([{ id: "c1", dropRate: 1 }]);
  });
});
