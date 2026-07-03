import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #393: the card-pack migration must add the three collection columns,
// keep them backward compatible (nullable, IF NOT EXISTS), reject blank names at
// the DB level, and NOT introduce any permissive public RLS policy.
describe("card collection migration (00061)", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../supabase/migrations/00061_add_card_collection_names.sql"),
    "utf8"
  );

  it("adds collection columns on all three tables, backward compatibly", () => {
    expect(sql).toMatch(/alter table public\.cards\s+add column if not exists collection_name text/i);
    expect(sql).toMatch(
      /alter table public\.streamers\s+add column if not exists channel_point_collection_name text/i
    );
    expect(sql).toMatch(
      /alter table public\.streamer_additional_gacha_rewards\s+add column if not exists collection_name text/i
    );
  });

  it("enforces a btrim length constraint so blank/whitespace names are rejected", () => {
    // All three CHECKs use char_length(btrim(...)) BETWEEN 1 AND 80.
    const checks = sql.match(/char_length\(btrim\([^)]+\)\)\s+between\s+1\s+and\s+80/gi) ?? [];
    expect(checks.length).toBe(3);
  });

  it("creates a partial index for pack-scoped card lookups", () => {
    expect(sql).toMatch(/create index if not exists idx_cards_streamer_collection/i);
    expect(sql).toMatch(/where collection_name is not null/i);
  });

  it("does not introduce permissive public RLS policies", () => {
    expect(sql).not.toMatch(/FOR ALL\s+USING\s*\(true\)/i);
    expect(sql).not.toMatch(/TO\s+authenticated/i);
  });
});
