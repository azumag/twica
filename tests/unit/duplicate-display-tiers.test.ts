import { describe, expect, it } from "vitest";
import {
  MAX_DUPLICATE_TIER_ENTRIES,
  MAX_DUPLICATE_TIER_THRESHOLD,
  MAX_DUPLICATE_TIERS,
  MIN_DUPLICATE_TIER_THRESHOLD,
  NO_DUPLICATE_TIER,
  duplicateTierBadgeClass,
  duplicateTierFrameClass,
  normalizeDuplicateTierThresholds,
  resolveDuplicateTier,
  sanitizeDuplicateDisplayTiers,
  validateDuplicateDisplayTiers,
} from "@/lib/duplicate-display-tiers";

// Issue #1782（要望 #1728）: 被りカードの「所有枚数に応じた表示段階」の純粋ロジック。
// 保存側（API route）・設定UI・視聴者表示（コレクション / カード詳細）が同じ規則を
// 使うため、「保存できたのに反映されない」が起きないことをここで固定する。

describe("normalizeDuplicateTierThresholds", () => {
  it("厳密増加する 1..3 要素の整数配列をそのまま通す", () => {
    expect(normalizeDuplicateTierThresholds([2])).toEqual([2]);
    expect(normalizeDuplicateTierThresholds([2, 5])).toEqual([2, 5]);
    expect(normalizeDuplicateTierThresholds([3, 6, 10])).toEqual([3, 6, 10]);
  });

  it("しきい値 1 を弾く（1枚は「被り」ではない）", () => {
    expect(normalizeDuplicateTierThresholds([1])).toBeNull();
    expect(normalizeDuplicateTierThresholds([1, 5])).toBeNull();
    expect(normalizeDuplicateTierThresholds([2, 1])).toBeNull();
  });

  it("上限を超えるしきい値を弾く", () => {
    expect(normalizeDuplicateTierThresholds([MAX_DUPLICATE_TIER_THRESHOLD])).toEqual([
      MAX_DUPLICATE_TIER_THRESHOLD,
    ]);
    expect(normalizeDuplicateTierThresholds([MAX_DUPLICATE_TIER_THRESHOLD + 1])).toBeNull();
  });

  it("同値・降順を弾く（何枚で何段階かが一意に定まらないため）", () => {
    expect(normalizeDuplicateTierThresholds([3, 3])).toBeNull();
    expect(normalizeDuplicateTierThresholds([5, 2])).toBeNull();
    expect(normalizeDuplicateTierThresholds([2, 5, 5])).toBeNull();
    expect(normalizeDuplicateTierThresholds([10, 6, 3])).toBeNull();
  });

  it("段階数の上限を超える配列を弾く", () => {
    expect(normalizeDuplicateTierThresholds([2, 3, 4])).toHaveLength(MAX_DUPLICATE_TIERS);
    expect(normalizeDuplicateTierThresholds([2, 3, 4, 5])).toBeNull();
  });

  it("空配列・非配列・小数・非整数を弾く", () => {
    expect(normalizeDuplicateTierThresholds([])).toBeNull();
    expect(normalizeDuplicateTierThresholds(undefined)).toBeNull();
    expect(normalizeDuplicateTierThresholds(null)).toBeNull();
    expect(normalizeDuplicateTierThresholds("2")).toBeNull();
    expect(normalizeDuplicateTierThresholds({ 0: 2 })).toBeNull();
    expect(normalizeDuplicateTierThresholds([2.5])).toBeNull();
    expect(normalizeDuplicateTierThresholds([NaN])).toBeNull();
    expect(normalizeDuplicateTierThresholds([Infinity])).toBeNull();
  });
});

describe("validateDuplicateDisplayTiers", () => {
  it("null は「全クリア（機能OFF）」として許可する", () => {
    expect(validateDuplicateDisplayTiers(null)).toEqual({ ok: true, value: null });
  });

  it("空オブジェクトは「どのレアリティも段階表示しない」設定として許可する", () => {
    expect(validateDuplicateDisplayTiers({})).toEqual({ ok: true, value: {} });
  });

  it("キーを trim + NFC 正規化して保存する", () => {
    const result = validateDuplicateDisplayTiers({ "  legendary  ": [2, 5] });
    expect(result).toEqual({ ok: true, value: { legendary: [2, 5] } });
  });

  it("trim で衝突するキーは黙ってマージせず拒否する", () => {
    expect(validateDuplicateDisplayTiers({ legendary: [2], " legendary ": [5] }).ok).toBe(false);
  });

  it("NFC 正規化後に衝突するキーは黙ってマージせず拒否する", () => {
    // "épic" と NFD 表現の "épic" は別の文字列だが、NFC 正規化後は同一になり、
    // 片方の段階設計が黙って上書きされる。merge せず拒否する。
    expect(validateDuplicateDisplayTiers({ "\u00e9pic": [2], "e\u0301pic": [5] }).ok).toBe(
      false
    );
  });

  it("NFC 正規化したキーで保存する", () => {
    expect(validateDuplicateDisplayTiers({ "e\u0301pic": [2, 5] })).toEqual({
      ok: true,
      value: { "\u00e9pic": [2, 5] },
    });
  });

  it("制御文字・Bidi override を含むキーを弾く", () => {
    expect(validateDuplicateDisplayTiers({ "bad\u0000key": [2] }).ok).toBe(false);
    expect(validateDuplicateDisplayTiers({ "bad\u202Ekey": [2] }).ok).toBe(false);
  });

  it("長さ 0 / 41 文字以上のキーを弾く", () => {
    expect(validateDuplicateDisplayTiers({ "": [2] }).ok).toBe(false);
    expect(validateDuplicateDisplayTiers({ ["a".repeat(41)]: [2] }).ok).toBe(false);
    expect(validateDuplicateDisplayTiers({ ["a".repeat(40)]: [2] }).ok).toBe(true);
  });

  it("配列・文字列など object 以外を弾く", () => {
    expect(validateDuplicateDisplayTiers([]).ok).toBe(false);
    expect(validateDuplicateDisplayTiers("x").ok).toBe(false);
    expect(validateDuplicateDisplayTiers(42).ok).toBe(false);
  });

  it("レアリティ数の上限を超える入力を弾く", () => {
    const tooMany: Record<string, number[]> = {};
    for (let index = 0; index <= MAX_DUPLICATE_TIER_ENTRIES; index += 1) {
      tooMany[`rarity-${index}`] = [2];
    }
    expect(validateDuplicateDisplayTiers(tooMany).ok).toBe(false);

    const atLimit: Record<string, number[]> = {};
    for (let index = 0; index < MAX_DUPLICATE_TIER_ENTRIES; index += 1) {
      atLimit[`rarity-${index}`] = [2];
    }
    expect(validateDuplicateDisplayTiers(atLimit).ok).toBe(true);
  });

  it("値が不正なエントリを含むマップ全体を拒否する（部分保存しない）", () => {
    expect(validateDuplicateDisplayTiers({ legendary: [2, 5], common: [1] }).ok).toBe(false);
    expect(validateDuplicateDisplayTiers({ legendary: [2, 5], common: "3" }).ok).toBe(false);
  });
});

describe("sanitizeDuplicateDisplayTiers", () => {
  it("壊れたエントリだけを落とし、有効なエントリは残す", () => {
    expect(
      sanitizeDuplicateDisplayTiers({
        legendary: [2, 5],
        common: [1], // しきい値 1 は不正
        epic: [4, 2], // 降順は不正
        rare: "2", // 配列でない
      })
    ).toEqual({ legendary: [2, 5] });
  });

  it("未設定・非objectは空マップ（＝全カード段階 0）に倒す", () => {
    expect(sanitizeDuplicateDisplayTiers(undefined)).toEqual({});
    expect(sanitizeDuplicateDisplayTiers(null)).toEqual({});
    expect(sanitizeDuplicateDisplayTiers([])).toEqual({});
    expect(sanitizeDuplicateDisplayTiers("{}")).toEqual({});
  });
});

describe("resolveDuplicateTier", () => {
  const tiers = { legendary: [2, 5], common: [3, 6, 10] };

  it("しきい値の到達状況に応じて段階を 1 段ずつ上げる", () => {
    expect(resolveDuplicateTier(tiers, "common", 1)).toBe(NO_DUPLICATE_TIER);
    expect(resolveDuplicateTier(tiers, "common", 2)).toBe(NO_DUPLICATE_TIER);
    expect(resolveDuplicateTier(tiers, "common", 3)).toBe(1);
    expect(resolveDuplicateTier(tiers, "common", 5)).toBe(1);
    expect(resolveDuplicateTier(tiers, "common", 6)).toBe(2);
    expect(resolveDuplicateTier(tiers, "common", 9)).toBe(2);
    expect(resolveDuplicateTier(tiers, "common", 10)).toBe(3);
    expect(resolveDuplicateTier(tiers, "common", 999)).toBe(3);
  });

  it("段階数が 2 のレアリティでは最大 2 で止まる", () => {
    expect(resolveDuplicateTier(tiers, "legendary", 2)).toBe(1);
    expect(resolveDuplicateTier(tiers, "legendary", 5)).toBe(2);
    expect(resolveDuplicateTier(tiers, "legendary", 100)).toBe(2);
  });

  it("未設定レアリティ・未所持・不正な所有枚数は段階 0", () => {
    expect(resolveDuplicateTier(tiers, "epic", 10)).toBe(NO_DUPLICATE_TIER);
    expect(resolveDuplicateTier(tiers, "common", 0)).toBe(NO_DUPLICATE_TIER);
    expect(resolveDuplicateTier(tiers, "common", Number.NaN)).toBe(NO_DUPLICATE_TIER);
    expect(resolveDuplicateTier(null, "common", 10)).toBe(NO_DUPLICATE_TIER);
    expect(resolveDuplicateTier(undefined, "common", 10)).toBe(NO_DUPLICATE_TIER);
  });
});

describe("duplicateTierBadgeClass / duplicateTierFrameClass", () => {
  it("段階 0 では何も出さない", () => {
    expect(duplicateTierBadgeClass(0)).toBe("");
    expect(duplicateTierFrameClass(0)).toBe("");
  });

  it("段階が上がるほどリングを強くする（どの段階も互いに異なる見た目）", () => {
    // 段階 1 と 2 が同一クラスだと「2段階目だけ見分けが付かない」ため、
    // 3段階すべてが互いに異なることを固定する。
    const frames = [1, 2, 3].map((tier) => duplicateTierFrameClass(tier));
    const badges = [1, 2, 3].map((tier) => duplicateTierBadgeClass(tier));
    expect(new Set(frames).size).toBe(3);
    expect(new Set(badges).size).toBe(3);
    expect(duplicateTierFrameClass(3)).toContain("ring-2");
    expect(duplicateTierFrameClass(1)).toContain("ring-1");
    expect(duplicateTierFrameClass(2)).toContain("ring-1");
  });

  it("範囲外の段階ではバッジを出さない（fail-closed）", () => {
    expect(duplicateTierBadgeClass(4)).toBe("");
    expect(duplicateTierBadgeClass(-1)).toBe("");
  });
});

describe("しきい値の定義域", () => {
  it("MIN は 2（1枚は被りではない）", () => {
    expect(MIN_DUPLICATE_TIER_THRESHOLD).toBe(2);
  });

  it("最大段階数は 3（問い合わせ #1728 の 1→2→3 段階の例に一致）", () => {
    expect(MAX_DUPLICATE_TIERS).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DB CHECK 制約（public.check_duplicate_display_tiers_values）との parity。
//
// この表は Homebrew PostgreSQL 17.10 上に migration を適用し、実測した
// check_duplicate_display_tiers_values の戻り値と1件ずつ突き合わせて作成した。
// アプリ層（validateDuplicateDisplayTiers）と DB 層で判定がずれると、
// 「API は 200 を返すのに DB が CHECK 違反で保存に失敗する」（= 500 になる）
// または「DB には入るが表示側が無視する」が起きるため、両者が同一の規則を
// 持つことをここで固定する。
// ---------------------------------------------------------------------------
describe("DB CHECK 制約との parity（PostgreSQL 17 で実測した判定と一致）", () => {
  const cases: { name: string; value: unknown; dbValid: boolean }[] = [
    { name: "NULL（既定 = 機能OFF）", value: null, dbValid: true },
    { name: "空オブジェクト", value: {}, dbValid: true },
    { name: "2段階", value: { legendary: [2, 5] }, dbValid: true },
    { name: "3段階", value: { legendary: [3, 6, 10] }, dbValid: true },
    { name: "しきい値 9999（上限ちょうど）", value: { legendary: [9999] }, dbValid: true },
    { name: "しきい値 1", value: { legendary: [1] }, dbValid: false },
    { name: "降順", value: { legendary: [5, 2] }, dbValid: false },
    { name: "同値", value: { legendary: [3, 3] }, dbValid: false },
    { name: "4段階", value: { legendary: [2, 3, 4, 5] }, dbValid: false },
    { name: "空配列", value: { legendary: [] }, dbValid: false },
    { name: "配列でない値", value: { legendary: "2" }, dbValid: false },
    { name: "小数", value: { legendary: [2.5] }, dbValid: false },
    { name: "しきい値 10000（上限超え）", value: { legendary: [10000] }, dbValid: false },
    { name: "object でない", value: [], dbValid: false },
    { name: "キー 41 文字", value: { ["a".repeat(41)]: [2] }, dbValid: false },
    { name: "キーに制御文字", value: { [`ok${String.fromCharCode(7)}x`]: [2] }, dbValid: false },
    {
      name: "キーに Bidi override",
      value: { [`ok${String.fromCharCode(8234)}x`]: [2] },
      dbValid: false,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → ${testCase.dbValid ? "valid" : "invalid"}`, () => {
      expect(validateDuplicateDisplayTiers(testCase.value).ok).toBe(testCase.dbValid);
    });
  }

  it("55件目のレアリティを弾く（DB 側の entry_count > 54 と同じ）", () => {
    const tooMany: Record<string, number[]> = {};
    for (let index = 0; index < 55; index += 1) {
      tooMany[`rarity-${index}`] = [2];
    }
    expect(validateDuplicateDisplayTiers(tooMany).ok).toBe(false);
    delete tooMany["rarity-54"];
    expect(validateDuplicateDisplayTiers(tooMany).ok).toBe(true);
  });
});
