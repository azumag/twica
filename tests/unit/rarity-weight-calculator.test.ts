import { describe, expect, it } from "vitest";
import { calculateDropRates } from "@/lib/rarity-weight-calculator";

describe("calculateDropRates", () => {
  it("calculates per-card drop rates from rarity percentages (equal intra weights)", () => {
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

  it("sets 0 (excluded) for rarities missing in rarityWeights to keep configured total intact", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "m1", rarity: "mythic", is_active: true },
        { id: "m2", rarity: "mythic", is_active: true },
      ],
      { common: 60 }
    );

    // mythic は重み未設定 → 0%（排出対象外）。均等fallbackで合計が100%を
    // 超えるのを防ぐ。
    expect(result).toEqual([
      { id: "c1", dropRate: 0.6 },
      { id: "m1", dropRate: 0 },
      { id: "m2", dropRate: 0 },
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

  it("sets 0 for NaN or Infinity weight values", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "c2", rarity: "rare", is_active: true },
      ],
      { common: NaN, rare: Infinity }
    );

    // NaN/Infinity は isValidPercent で弾かれ、0%（排出対象外）となる
    expect(result).toEqual([
      { id: "c1", dropRate: 0 },
      { id: "c2", dropRate: 0 },
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

  it("sets 0 for all cards when rarityWeights is empty object", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "c2", rarity: "rare", is_active: true },
      ],
      {}
    );

    // 空オブジェクト → 全レアリティが重み未設定 → 0%（排出対象外）
    expect(result).toEqual([
      { id: "c1", dropRate: 0 },
      { id: "c2", dropRate: 0 },
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

  it("sets 0 for negative weight values", () => {
    const result = calculateDropRates(
      [{ id: "c1", rarity: "common", is_active: true }],
      { common: -5 }
    );

    // 負の値は isValidPercent で弾かれ、0%（排出対象外）となる
    expect(result).toEqual([{ id: "c1", dropRate: 0 }]);
  });

  // ---- intra_rarity_weight テスト ----

  it("distributes weight proportionally within rarity using intra_rarity_weight", () => {
    // レア2枚: 重み1と4 → レア10%のうち 1/5=2%, 4/5=8%
    const result = calculateDropRates(
      [
        { id: "r1", rarity: "rare", is_active: true, intra_rarity_weight: 1.0 },
        { id: "r2", rarity: "rare", is_active: true, intra_rarity_weight: 4.0 },
        { id: "c1", rarity: "common", is_active: true, intra_rarity_weight: 1.0 },
      ],
      { common: 50, rare: 10 }
    );

    expect(result).toEqual([
      { id: "r1", dropRate: 0.02 },   // 10% * (1/5) = 2%
      { id: "r2", dropRate: 0.08 },   // 10% * (4/5) = 8%
      { id: "c1", dropRate: 0.5 },    // 50% * (1/1) = 50%
    ]);
  });

  it("treats undefined intra_rarity_weight as 1.0 (backward compatible)", () => {
    // intra_rarity_weight未指定のカードは1.0として扱う
    const result = calculateDropRates(
      [
        { id: "r1", rarity: "rare", is_active: true },                               // undefined → 1.0
        { id: "r2", rarity: "rare", is_active: true, intra_rarity_weight: 3.0 },
      ],
      { rare: 20 }
    );

    // r1: 20% * (1/4) = 5%, r2: 20% * (3/4) = 15%
    expect(result).toEqual([
      { id: "r1", dropRate: 0.05 },
      { id: "r2", dropRate: 0.15 },
    ]);
  });

  it("handles all cards with same intra_rarity_weight (equal distribution)", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true, intra_rarity_weight: 2.0 },
        { id: "c2", rarity: "common", is_active: true, intra_rarity_weight: 2.0 },
      ],
      { common: 40 }
    );

    // 均等配分: 40% / 2 = 20% each
    expect(result).toEqual([
      { id: "c1", dropRate: 0.2 },
      { id: "c2", dropRate: 0.2 },
    ]);
  });

  it("handles extreme intra_rarity_weight ratios", () => {
    const result = calculateDropRates(
      [
        { id: "r1", rarity: "rare", is_active: true, intra_rarity_weight: 0.01 },
        { id: "r2", rarity: "rare", is_active: true, intra_rarity_weight: 99.99 },
      ],
      { rare: 50 }
    );

    // r1: 50% * (0.01/100) = 0.005% → 0.0001
    // r2: 50% * (99.99/100) = 49.995% → 0.4999 (4桁丸め)
    expect(result).toEqual([
      { id: "r1", dropRate: 0.0001 },
      { id: "r2", dropRate: 0.4999 },
    ]);
  });

  it("sets 0 for unconfigured rarities regardless of intra_rarity_weight", () => {
    // rarityWeightsに存在しないレアリティは0%（排出対象外）。
    // intra_rarity_weightは計算に使われない。
    const result = calculateDropRates(
      [
        { id: "m1", rarity: "mythic", is_active: true, intra_rarity_weight: 5.0 },
        { id: "m2", rarity: "mythic", is_active: true, intra_rarity_weight: 1.0 },
        { id: "c1", rarity: "common", is_active: true },
      ],
      { common: 60 }
    );

    // mythic は重み未設定 → 0% (intra_rarity_weightは無視)
    expect(result).toEqual([
      { id: "m1", dropRate: 0 },
      { id: "m2", dropRate: 0 },
      { id: "c1", dropRate: 0.6 },
    ]);
  });

  it("excludes unconfigured custom rarity so total never exceeds the configured 100%", () => {
    // C4 回帰テスト: カスタムレアリティ(mythic)が重み未設定でも、
    // 設定済みレアリティの合計(100%)を超えない。
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true },
        { id: "r1", rarity: "rare", is_active: true },
        { id: "m1", rarity: "mythic", is_active: true },
        { id: "m2", rarity: "mythic", is_active: true },
      ],
      { common: 70, rare: 30 }
    );

    const total = result.reduce((sum, r) => sum + r.dropRate, 0);
    expect(total).toBeCloseTo(1.0, 4);
    expect(result).toEqual([
      { id: "c1", dropRate: 0.7 },
      { id: "r1", dropRate: 0.3 },
      { id: "m1", dropRate: 0 },
      { id: "m2", dropRate: 0 },
    ]);
  });

  it("correctly distributes across multiple rarities with different intra weights", () => {
    const result = calculateDropRates(
      [
        { id: "c1", rarity: "common", is_active: true, intra_rarity_weight: 3.0 },
        { id: "c2", rarity: "common", is_active: true, intra_rarity_weight: 1.0 },
        { id: "r1", rarity: "rare", is_active: true, intra_rarity_weight: 1.0 },
        { id: "r2", rarity: "rare", is_active: true, intra_rarity_weight: 1.0 },
      ],
      { common: 80, rare: 20 }
    );

    expect(result).toEqual([
      { id: "c1", dropRate: 0.6 },    // 80% * (3/4) = 60%
      { id: "c2", dropRate: 0.2 },    // 80% * (1/4) = 20%
      { id: "r1", dropRate: 0.1 },    // 20% * (1/2) = 10%
      { id: "r2", dropRate: 0.1 },    // 20% * (1/2) = 10%
    ]);
  });
});
