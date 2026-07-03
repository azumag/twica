import { describe, expect, it } from "vitest";
import {
  countOwnedActiveCardTypes,
  createCollectionNumberMap,
  sortCollectedCards,
} from "@/lib/collection-utils";

describe("collection-utils", () => {
  describe("sortCollectedCards", () => {
    it("sorts by rarity first and newest first within the same rarity", () => {
      const cards = [
        { id: "common-new", rarity: "common" as const, created_at: "2026-03-03T00:00:00Z" },
        { id: "legendary-old", rarity: "legendary" as const, created_at: "2026-03-01T00:00:00Z" },
        { id: "legendary-new", rarity: "legendary" as const, created_at: "2026-03-02T00:00:00Z" },
        { id: "rare-new", rarity: "rare" as const, created_at: "2026-03-04T00:00:00Z" },
      ];

      expect(sortCollectedCards(cards).map((card) => card.id)).toEqual([
        "legendary-new",
        "legendary-old",
        "rare-new",
        "common-new",
      ]);
    });

    it("sorts custom rarities after all builtin rarities, not before them (Issue #505)", () => {
      // 修正前は RARITY_ORDER.indexOf() の -1 をそのまま比較に使っていたため、
      // カスタムレアリティ ("mythic") が legendary (index 0) より希少と
      // 誤判定され、一覧の先頭に来てしまうバグがあった。
      const cards = [
        { id: "custom-mythic", rarity: "mythic" as const, created_at: "2026-03-05T00:00:00Z" },
        { id: "common-new", rarity: "common" as const, created_at: "2026-03-03T00:00:00Z" },
        { id: "legendary-old", rarity: "legendary" as const, created_at: "2026-03-01T00:00:00Z" },
        { id: "legendary-new", rarity: "legendary" as const, created_at: "2026-03-02T00:00:00Z" },
        { id: "rare-new", rarity: "rare" as const, created_at: "2026-03-04T00:00:00Z" },
      ];

      expect(sortCollectedCards(cards).map((card) => card.id)).toEqual([
        "legendary-new",
        "legendary-old",
        "rare-new",
        "common-new",
        "custom-mythic",
      ]);
    });

    it("sorts by collection number when requested", () => {
      const cards = [
        { id: "third", rarity: "legendary" as const, created_at: "2026-03-03T00:00:00Z", collectionNumber: 3 },
        { id: "first", rarity: "common" as const, created_at: "2026-03-01T00:00:00Z", collectionNumber: 1 },
        { id: "second", rarity: "rare" as const, created_at: "2026-03-02T00:00:00Z", collectionNumber: 2 },
      ];

      expect(sortCollectedCards(cards, "number").map((card) => card.id)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });
  });

  describe("createCollectionNumberMap", () => {
    it("assigns stable card numbers by oldest created_at first", () => {
      const cards = [
        { id: "card-b", created_at: "2026-03-02T00:00:00Z" },
        { id: "card-a", created_at: "2026-03-01T00:00:00Z" },
        { id: "card-c", created_at: "2026-03-03T00:00:00Z" },
      ];

      expect(Object.fromEntries(createCollectionNumberMap(cards))).toEqual({
        "card-a": 1,
        "card-b": 2,
        "card-c": 3,
      });
    });

    it("honors manually assigned card numbers and fills gaps for the rest", () => {
      const cards = [
        { id: "card-a", created_at: "2026-03-01T00:00:00Z", card_number: null },
        { id: "card-b", created_at: "2026-03-02T00:00:00Z", card_number: 5 },
        { id: "card-c", created_at: "2026-03-03T00:00:00Z", card_number: null },
      ];

      expect(Object.fromEntries(createCollectionNumberMap(cards))).toEqual({
        "card-a": 1,
        "card-b": 5,
        "card-c": 2,
      });
    });

    it("deduplicates repeated cards before numbering", () => {
      const cards = [
        { id: "card-a", created_at: "2026-03-01T00:00:00Z" },
        { id: "card-a", created_at: "2026-03-01T00:00:00Z" },
        { id: "card-b", created_at: "2026-03-02T00:00:00Z" },
      ];

      expect(Object.fromEntries(createCollectionNumberMap(cards))).toEqual({
        "card-a": 1,
        "card-b": 2,
      });
    });
  });

  describe("countOwnedActiveCardTypes", () => {
    it("counts only unique owned cards that are still active", () => {
      const ownedCards = [
        { id: "active-1" },
        { id: "active-1" },
        { id: "active-2" },
        { id: "inactive-1" },
      ];

      expect(countOwnedActiveCardTypes(ownedCards, ["active-1", "active-2"])).toBe(2);
    });

    it("returns 0 when there are no active owned cards", () => {
      const ownedCards = [{ id: "inactive-1" }];

      expect(countOwnedActiveCardTypes(ownedCards, [])).toBe(0);
    });
  });
});
