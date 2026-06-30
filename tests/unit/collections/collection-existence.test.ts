import { describe, expect, it } from "vitest";
import { isMissingCollectionNameColumn } from "@/lib/collections/collection-existence";

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
