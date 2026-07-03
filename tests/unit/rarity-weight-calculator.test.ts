import { describe, expect, it } from "vitest";
import {
  calculateDropRates,
  computeEffectiveWeights,
  resolveRarityWeightsForPool,
} from "@/lib/rarity-weight-calculator";

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

describe("computeEffectiveWeights", () => {
  it("computes mixed-rarity effective weights using the intra_rarity_weight distribution", () => {
    const pool = [
      { id: "c1", rarity: "common", intra_rarity_weight: 3.0 },
      { id: "c2", rarity: "common", intra_rarity_weight: 1.0 },
      { id: "r1", rarity: "rare", intra_rarity_weight: 1.0 },
      { id: "r2", rarity: "rare", intra_rarity_weight: 1.0 },
    ];

    const result = computeEffectiveWeights(pool, { common: 80, rare: 20 });

    expect(result.map((r) => r.card)).toEqual(pool);
    expect(result[0].effectiveWeight).toBeCloseTo(0.6, 10);   // 80% * (3/4)
    expect(result[1].effectiveWeight).toBeCloseTo(0.2, 10);   // 80% * (1/4)
    expect(result[2].effectiveWeight).toBeCloseTo(0.1, 10);   // 20% * (1/2)
    expect(result[3].effectiveWeight).toBeCloseTo(0.1, 10);   // 20% * (1/2)
  });

  it("coerces string intra_rarity_weight (Supabase may return NUMERIC as string) instead of concatenating", () => {
    // normalizeDropRate が drop_rate に対して存在するのと同じ理由:
    // NUMERIC 列は実行時に文字列で届きうる。文字列のまま合計すると
    // 0 + "3" + "1" → "031"(文字列連結)となり分母が壊れる回帰の防止。
    const pool = [
      { id: "c1", rarity: "common", intra_rarity_weight: "3.0" as unknown as number },
      { id: "c2", rarity: "common", intra_rarity_weight: "1.0" as unknown as number },
    ];

    const result = computeEffectiveWeights(pool, { common: 100 });

    expect(result[0].effectiveWeight).toBeCloseTo(0.75, 10);  // 100% * (3/4)
    expect(result[1].effectiveWeight).toBeCloseTo(0.25, 10);  // 100% * (1/4)
  });

  it("returns 0 for unset/invalid rarity percent (NaN, negative, missing key)", () => {
    const pool = [
      { id: "c1", rarity: "common" },
      { id: "r1", rarity: "rare" },
      { id: "m1", rarity: "mythic" },
    ];

    const result = computeEffectiveWeights(pool, { common: NaN, rare: -5 });

    expect(result).toEqual([
      { card: pool[0], effectiveWeight: 0 },
      { card: pool[1], effectiveWeight: 0 },
      { card: pool[2], effectiveWeight: 0 }, // mythic missing from rarityWeights entirely
    ]);
  });

  it("preserves relative ratios among configured rarities when another rarity is missing from the pool (sum < 1)", () => {
    // legendary は rarityWeights に設定されているがプールに存在しない。
    // common/rare の相対比率(50:30 = 5:3)はそのまま保たれ、
    // 有効重み合計は 0.8 (< 1) になる。selectWeightedCard 側の相対正規化に委ねる。
    const pool = [
      { id: "c1", rarity: "common" },
      { id: "r1", rarity: "rare" },
    ];

    const result = computeEffectiveWeights(pool, { common: 50, rare: 30, legendary: 20 });

    expect(result).toEqual([
      { card: pool[0], effectiveWeight: 0.5 },
      { card: pool[1], effectiveWeight: 0.3 },
    ]);
    const total = result.reduce((sum, r) => sum + r.effectiveWeight, 0);
    expect(total).toBeCloseTo(0.8, 10);
  });

  it("returns an empty array for an empty pool", () => {
    const result = computeEffectiveWeights([], { common: 100 });
    expect(result).toEqual([]);
  });

  it("does not round to 4 decimals (unlike calculateDropRates)", () => {
    const pool = [
      { id: "c1", rarity: "common" },
      { id: "c2", rarity: "common" },
      { id: "c3", rarity: "common" },
    ];

    const result = computeEffectiveWeights(pool, { common: 50 });

    // 50/3 = 16.666...% -> 0.16666...、四捨五入していないことを確認
    expect(result[0].effectiveWeight).toBeCloseTo(1 / 6, 10);
    expect(result[0].effectiveWeight).not.toBe(0.1667);
  });
});

describe("resolveRarityWeightsForPool", () => {
  const global = { common: 70, rare: 30 };
  const perPack = {
    weapons: { common: 40, rare: 60 },
  };

  it("returns global weights when scope is 'global'", () => {
    const result = resolveRarityWeightsForPool("global", global, perPack, "weapons");
    expect(result).toBe(global);
  });

  it("returns the pack-specific weights when scope is 'per_pack' and an entry exists", () => {
    const result = resolveRarityWeightsForPool("per_pack", global, perPack, "weapons");
    expect(result).toBe(perPack.weapons);
  });

  it("falls back to global weights when scope is 'per_pack' but the pack has no entry (inherit)", () => {
    const result = resolveRarityWeightsForPool("per_pack", global, perPack, "characters");
    expect(result).toBe(global);
  });

  it("falls back to global weights when scope is 'per_pack' but the pack entry is an empty object", () => {
    const result = resolveRarityWeightsForPool(
      "per_pack",
      global,
      { weapons: {} },
      "weapons"
    );
    expect(result).toBe(global);
  });

  it("returns null (manual mode) when rarityWeights is null", () => {
    const result = resolveRarityWeightsForPool("global", null, perPack, "weapons");
    expect(result).toBeNull();
  });

  it("returns null (manual mode) when rarityWeights is an empty object", () => {
    const result = resolveRarityWeightsForPool("per_pack", {}, perPack, "weapons");
    expect(result).toBeNull();
  });

  it("treats an undefined scope as 'global'", () => {
    const result = resolveRarityWeightsForPool(undefined, global, perPack, "weapons");
    expect(result).toBe(global);
  });

  it("treats a null/unknown scope as 'global'", () => {
    expect(resolveRarityWeightsForPool(null, global, perPack, "weapons")).toBe(global);
    expect(resolveRarityWeightsForPool("unknown-scope", global, perPack, "weapons")).toBe(global);
  });
});
