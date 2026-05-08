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
