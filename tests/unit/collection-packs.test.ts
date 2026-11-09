import { describe, expect, it } from "vitest";
import {
  cardMatchesPackKey,
  computePackProgress,
  deriveCollectionPackGroups,
  resolveCardPackKey,
  resolvePackDisplayName,
} from "@/lib/collection-packs";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";

// Issue #557: pure pack-grouping/progress helpers for the viewer collection
// page's pack filter.

const card = (id: string, collection_name: string | null) => ({ id, collection_name });

describe("collection-packs", () => {
  describe("cardMatchesPackKey", () => {
    it("matches unclassified cards (null) against DEFAULT_PACK_SENTINEL", () => {
      expect(cardMatchesPackKey(null, DEFAULT_PACK_SENTINEL)).toBe(true);
      expect(cardMatchesPackKey("weapons", DEFAULT_PACK_SENTINEL)).toBe(false);
    });

    it("matches named packs by exact collection_name", () => {
      expect(cardMatchesPackKey("weapons", "weapons")).toBe(true);
      expect(cardMatchesPackKey("weapons", "characters")).toBe(false);
      expect(cardMatchesPackKey(null, "weapons")).toBe(false);
    });
  });

  describe("deriveCollectionPackGroups", () => {
    it("returns no groups when there are no active cards", () => {
      expect(deriveCollectionPackGroups([], ["weapons"])).toEqual([]);
    });

    it("returns only the default group when every active card is unclassified", () => {
      expect(
        deriveCollectionPackGroups([card("a", null), card("b", null)], [])
      ).toEqual([{ key: DEFAULT_PACK_SENTINEL, isDefault: true }]);
    });

    it("omits the default group when no active card is unclassified", () => {
      expect(
        deriveCollectionPackGroups([card("a", "weapons")], ["weapons"])
      ).toEqual([{ key: "weapons", isDefault: false }]);
    });

    it("puts the default group first, then named packs in catalog order", () => {
      const groups = deriveCollectionPackGroups(
        [card("a", "characters"), card("b", null), card("c", "weapons")],
        ["weapons", "characters"]
      );
      expect(groups).toEqual([
        { key: DEFAULT_PACK_SENTINEL, isDefault: true },
        { key: "weapons", isDefault: false },
        { key: "characters", isDefault: false },
      ]);
    });

    it("omits catalog packs that have no active cards (an empty tab could never complete)", () => {
      const groups = deriveCollectionPackGroups(
        [card("a", "weapons")],
        ["weapons", "empty-pack"]
      );
      expect(groups.map((group) => group.key)).toEqual(["weapons"]);
    });

    it("appends orphaned pack names (on cards but removed from the catalog) last, in first-seen order", () => {
      const groups = deriveCollectionPackGroups(
        [
          card("a", "orphan-b"),
          card("b", "weapons"),
          card("c", "orphan-a"),
          card("d", "orphan-b"),
        ],
        ["weapons"]
      );
      expect(groups.map((group) => group.key)).toEqual([
        "weapons",
        "orphan-b",
        "orphan-a",
      ]);
    });
  });

  describe("computePackProgress", () => {
    const activeCards = [
      card("w1", "weapons"),
      card("w2", "weapons"),
      card("u1", null),
    ];

    it("counts total as unique active cards in the pack and owned as the owned subset", () => {
      expect(
        computePackProgress([{ id: "w1" }], activeCards, "weapons")
      ).toEqual({ owned: 1, total: 2 });
    });

    it("resolves DEFAULT_PACK_SENTINEL to unclassified cards", () => {
      expect(
        computePackProgress([{ id: "u1" }, { id: "w1" }], activeCards, DEFAULT_PACK_SENTINEL)
      ).toEqual({ owned: 1, total: 1 });
    });

    it("ignores owned duplicates and owned cards outside the pack", () => {
      expect(
        computePackProgress(
          [{ id: "w1" }, { id: "w1" }, { id: "u1" }, { id: "not-active" }],
          activeCards,
          "weapons"
        )
      ).toEqual({ owned: 1, total: 2 });
    });

    it("returns 0/0 for a pack with no active cards", () => {
      expect(computePackProgress([{ id: "w1" }], activeCards, "characters")).toEqual({
        owned: 0,
        total: 0,
      });
    });
  });

  // Issue #948: {packName} 用に、獲得カード自身のパックキーを解決する。
  // PR #972 レビュー指摘: eventsub-redemption.ts 内の三項＋??混在の可読性・
  // 空文字collection_nameのエッジケースを、純粋関数へ切り出して直接テスト
  // できるようにした。#974 で旧outbox payload向けの抽選スコープへの
  // フォールバック（undefined 分岐と drawScopeCollectionName 引数）を撤去
  // し、常にカード自身の collection_name だけを見る形に単純化した
  // （撤去前に本番outboxの対象行0件をread-onlyで実測済み）。
  describe("resolveCardPackKey", () => {
    it("resolves to DEFAULT_PACK_SENTINEL when the card is unclassified (null)", () => {
      expect(resolveCardPackKey(null)).toBe(DEFAULT_PACK_SENTINEL);
    });

    it("treats an empty string the same as null (defensive: normalizeCollectionName blanks to null at write time)", () => {
      expect(resolveCardPackKey("")).toBe(DEFAULT_PACK_SENTINEL);
    });

    it("treats a missing key (undefined) as unclassified (defensive; the payload decoder may still tolerate it)", () => {
      expect(resolveCardPackKey(undefined)).toBe(DEFAULT_PACK_SENTINEL);
    });

    it("returns the card's own named pack verbatim", () => {
      expect(resolveCardPackKey("レアパック")).toBe("レアパック");
    });
  });

  // Issue #597: {packName} チャット通知プレースホルダの表示名解決。
  describe("resolvePackDisplayName", () => {
    it("returns an empty string when the draw was not restricted to any pack (null)", () => {
      expect(resolvePackDisplayName(null, "レアパック", "デフォルトパック")).toBe("");
    });

    it("returns an empty string when collectionName is undefined", () => {
      expect(resolvePackDisplayName(undefined, "レアパック", "デフォルトパック")).toBe("");
    });

    it("returns the streamer's override for the default (unclassified) pseudo-pack", () => {
      expect(
        resolvePackDisplayName(DEFAULT_PACK_SENTINEL, "スターターパック", "デフォルトパック")
      ).toBe("スターターパック");
    });

    it("falls back to the generic label when the default pack has no override", () => {
      expect(resolvePackDisplayName(DEFAULT_PACK_SENTINEL, null, "デフォルトパック")).toBe(
        "デフォルトパック"
      );
    });

    it("returns the named pack's collection_name verbatim, ignoring defaultPackName", () => {
      expect(resolvePackDisplayName("weapons", "スターターパック", "デフォルトパック")).toBe(
        "weapons"
      );
    });
  });
});
