import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACK_SENTINEL,
  MAX_COLLECTION_NAME_LENGTH,
  MAX_REWARD_PACK_NAMES,
  findUnregisteredRewardPackName,
  resolveCollectionNamesField,
  resolveEffectiveRewardPackNames,
  toLegacyCollectionName,
} from "@/lib/validation/collection-name";
import { MAX_CARD_PACK_NAMES } from "@/lib/constants";

// Issue #1994: 1つのチャネルポイント報酬に複数パックを割り当てる機能の純関数群。
// 保存形式（新しい配列列 + 旧単一列ミラー）と API 入力の正規化規則を固定する。

describe("MAX_REWARD_PACK_NAMES", () => {
  it("is the registered-pack catalog cap plus the default-pack sentinel", () => {
    expect(MAX_REWARD_PACK_NAMES).toBe(MAX_CARD_PACK_NAMES + 1);
  });
});

describe("resolveEffectiveRewardPackNames", () => {
  it("falls back to the legacy single column when the array column is empty/null/missing", () => {
    expect(resolveEffectiveRewardPackNames([], "weapons")).toEqual(["weapons"]);
    expect(resolveEffectiveRewardPackNames(null, "weapons")).toEqual(["weapons"]);
    expect(resolveEffectiveRewardPackNames(undefined, "weapons")).toEqual(["weapons"]);
    expect(resolveEffectiveRewardPackNames(undefined, DEFAULT_PACK_SENTINEL)).toEqual([DEFAULT_PACK_SENTINEL]);
  });

  it("returns [] (= all cards) when both columns are empty", () => {
    expect(resolveEffectiveRewardPackNames([], null)).toEqual([]);
    expect(resolveEffectiveRewardPackNames(undefined, undefined)).toEqual([]);
    expect(resolveEffectiveRewardPackNames(null, "")).toEqual([]);
  });

  it("uses the array column when its first element matches the legacy mirror", () => {
    expect(resolveEffectiveRewardPackNames(["weapons", "characters"], "weapons")).toEqual([
      "weapons",
      "characters",
    ]);
    expect(resolveEffectiveRewardPackNames(["weapons"], "weapons")).toEqual(["weapons"]);
  });

  it("de-duplicates array elements (first occurrence wins) and drops non-strings / blanks", () => {
    expect(
      resolveEffectiveRewardPackNames(["weapons", "characters", "weapons", 3, "", null], "weapons")
    ).toEqual(["weapons", "characters"]);
  });

  // 新コードは常に「旧列 = 配列の先頭」を書く。食い違いは配列を知らない書き手
  // （ロールバックした旧コード等）が旧列だけを書き換えた証拠なので、旧列を正とする。
  it("lets the legacy column win when it disagrees with the array head (written by an array-unaware writer)", () => {
    expect(resolveEffectiveRewardPackNames(["weapons", "characters"], "other")).toEqual(["other"]);
    expect(resolveEffectiveRewardPackNames(["weapons", "characters"], null)).toEqual([]);
  });

  it("ignores non-array JSON values defensively", () => {
    expect(resolveEffectiveRewardPackNames({ a: 1 }, "weapons")).toEqual(["weapons"]);
    expect(resolveEffectiveRewardPackNames("weapons", null)).toEqual([]);
  });
});

describe("toLegacyCollectionName", () => {
  it("mirrors the first element, or null for an empty selection", () => {
    expect(toLegacyCollectionName(["a", "b"])).toBe("a");
    expect(toLegacyCollectionName(["a"])).toBe("a");
    expect(toLegacyCollectionName([])).toBeNull();
  });
});

describe("resolveCollectionNamesField", () => {
  const resolve = (body: Record<string, unknown>) =>
    resolveCollectionNamesField(body, "collectionNames", "collectionName");

  it("returns undefined when neither field is present (column untouched)", () => {
    expect(resolve({})).toEqual({ ok: true, value: undefined });
  });

  it("accepts the legacy single-value field for backward compatibility", () => {
    expect(resolve({ collectionName: " weapons " })).toEqual({ ok: true, value: ["weapons"] });
    expect(resolve({ collectionName: null })).toEqual({ ok: true, value: [] });
    expect(resolve({ collectionName: "" })).toEqual({ ok: true, value: [] });
    expect(resolve({ collectionName: DEFAULT_PACK_SENTINEL })).toEqual({
      ok: true,
      value: [DEFAULT_PACK_SENTINEL],
    });
  });

  it("rejects an invalid legacy value the same way as resolveCollectionNameField", () => {
    expect(resolve({ collectionName: 123 })).toEqual({ ok: false });
    expect(resolve({ collectionName: "x".repeat(MAX_COLLECTION_NAME_LENGTH + 1) })).toEqual({ ok: false });
  });

  it("accepts an array, trimming and de-duplicating while preserving order", () => {
    expect(resolve({ collectionNames: [" weapons", "characters", "weapons "] })).toEqual({
      ok: true,
      value: ["weapons", "characters"],
    });
  });

  it("treats null / [] as the explicit 'all cards' selection", () => {
    expect(resolve({ collectionNames: null })).toEqual({ ok: true, value: [] });
    expect(resolve({ collectionNames: [] })).toEqual({ ok: true, value: [] });
  });

  it("rejects non-array values and invalid elements", () => {
    expect(resolve({ collectionNames: "weapons" })).toEqual({ ok: false });
    expect(resolve({ collectionNames: ["weapons", 1] })).toEqual({ ok: false });
    expect(resolve({ collectionNames: ["weapons", "   "] })).toEqual({ ok: false });
    expect(resolve({ collectionNames: ["x".repeat(MAX_COLLECTION_NAME_LENGTH + 1)] })).toEqual({ ok: false });
  });

  it("enforces the element cap after de-duplication", () => {
    const atCap = Array.from({ length: MAX_REWARD_PACK_NAMES }, (_, i) => `p${i}`);
    expect(resolve({ collectionNames: atCap })).toEqual({ ok: true, value: atCap });
    expect(resolve({ collectionNames: [...atCap, "overflow"] })).toEqual({ ok: false });
    // 重複は除去後に数えるため、上限ちょうど + 重複は受理する。
    expect(resolve({ collectionNames: [...atCap, "p0"] })).toEqual({ ok: true, value: atCap });
  });

  it("rejects requests that send both the array and the legacy field (ambiguous)", () => {
    expect(resolve({ collectionNames: ["a"], collectionName: "a" })).toEqual({ ok: false });
  });
});

describe("findUnregisteredRewardPackName", () => {
  const registered = ["weapons", "characters"];

  it("returns null when every name is registered, the sentinel, or already bound (orphan kept)", () => {
    expect(findUnregisteredRewardPackName(["weapons", DEFAULT_PACK_SENTINEL], [], registered)).toBeNull();
    // "retired" はパック管理で登録解除済みだが、現在の紐付けに含まれるため維持できる。
    expect(findUnregisteredRewardPackName(["retired", "weapons"], ["retired"], registered)).toBeNull();
  });

  it("returns the first name that is neither registered nor currently bound", () => {
    expect(findUnregisteredRewardPackName(["weapons", "ghost", "other"], [], registered)).toBe("ghost");
    expect(findUnregisteredRewardPackName(["retired"], [], registered)).toBe("retired");
  });
});
