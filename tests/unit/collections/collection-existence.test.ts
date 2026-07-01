import { describe, expect, it, vi } from "vitest";
import { isMissingCollectionNameColumn, checkCollectionHasActiveCards } from "@/lib/collections/collection-existence";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import { createMockQueryBuilder } from "../../utils/supabase-mock";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

describe("isMissingCollectionNameColumn", () => {
  it("detects the WRITE shape (PGRST204 schema-cache miss)", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "PGRST204",
        message: "Could not find the 'collection_name' column of 'cards' in the schema cache",
      })
    ).toBe(true);
  });

  it("detects the READ shape (42703 'does not exist') — the deploy-window SELECT case", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "42703",
        message: "column cards.collection_name does not exist",
      })
    ).toBe(true);
  });

  it("detects channel_point_collection_name too (substring match)", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "42703",
        message: "column streamers.channel_point_collection_name does not exist",
      })
    ).toBe(true);
  });

  it("does NOT match raid-option schema errors (no false positive)", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "PGRST204",
        message: "Could not find the 'draw_count' column",
      })
    ).toBe(false);
    expect(
      isMissingCollectionNameColumn({
        code: "42703",
        message: "column streamer_additional_gacha_rewards.is_raid_limited does not exist",
      })
    ).toBe(false);
  });

  it("does NOT match unrelated columns even on a bare PGRST204", () => {
    expect(
      isMissingCollectionNameColumn({
        code: "PGRST204",
        message: "Could not find the 'some_other_column' column",
      })
    ).toBe(false);
  });

  it("does NOT match a NOT NULL constraint violation on collection_name (future-proofing)", () => {
    // 23502 mentions both "collection_name" and "column" but is a real write
    // failure, not a missing column — it must not be swallowed as schema-not-ready.
    expect(
      isMissingCollectionNameColumn({
        code: "23502",
        message:
          "null value in column \"collection_name\" of relation \"cards\" violates not-null constraint",
      })
    ).toBe(false);
  });

  it("returns false for null/empty errors", () => {
    expect(isMissingCollectionNameColumn(null)).toBe(false);
    expect(isMissingCollectionNameColumn(undefined)).toBe(false);
    expect(isMissingCollectionNameColumn({})).toBe(false);
  });
});

// Issue #555: DEFAULT_PACK_SENTINEL asks about the DEFAULT (unclassified) pack
// — collection_name IS NULL — the inverse of the normal named-pack `.eq(...)`
// lookup. Fixes the query shape used by checkCollectionHasActiveCards.
describe("checkCollectionHasActiveCards", () => {
  function buildCardsQuery(count: number | null, error: unknown = null) {
    const q = createMockQueryBuilder();
    (q as unknown as Record<string, unknown>).then = (resolve: (v: unknown) => void) => {
      resolve({ count, error });
      return q;
    };
    return q;
  }

  it("queries a normal pack name via .eq('collection_name', name)", async () => {
    const cardsQuery = buildCardsQuery(3);
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", "weapons");

    expect(result).toBe("exists");
    expect(cardsQuery.eq).toHaveBeenCalledWith("collection_name", "weapons");
    expect(cardsQuery.is).not.toHaveBeenCalled();
  });

  it("queries DEFAULT_PACK_SENTINEL via .is('collection_name', null), NOT .eq", async () => {
    const cardsQuery = buildCardsQuery(2);
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", DEFAULT_PACK_SENTINEL);

    expect(result).toBe("exists");
    expect(cardsQuery.is).toHaveBeenCalledWith("collection_name", null);
    // A literal .eq('collection_name', '__default__') would never match any real
    // card, so it must not be used for the sentinel.
    expect(cardsQuery.eq).not.toHaveBeenCalledWith("collection_name", DEFAULT_PACK_SENTINEL);
  });

  it("returns 'absent' when the default pack has zero active (unclassified) cards", async () => {
    const cardsQuery = buildCardsQuery(0);
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", DEFAULT_PACK_SENTINEL);
    expect(result).toBe("absent");
  });

  it("returns 'schema-not-ready' for the deploy-window column error even when checking the sentinel", async () => {
    const cardsQuery = buildCardsQuery(null, {
      code: "42703",
      message: "column cards.collection_name does not exist",
    });
    const supabase = { from: vi.fn(() => cardsQuery) } as unknown as SupabaseClient<Database>;

    const result = await checkCollectionHasActiveCards(supabase, "streamer-1", DEFAULT_PACK_SENTINEL);
    expect(result).toBe("schema-not-ready");
  });
});
