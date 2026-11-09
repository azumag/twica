import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(
    process.cwd(),
    "db/planetscale/migrations/20261024120000_drop_legacy_live_directory_rankings_rpc.sql",
  ),
  "utf8",
);

describe("live directory legacy RPC removal migration (Issue #933)", () => {
  it("declares the required migration descriptor", () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/);
  });

  it("drops the legacy ranking RPC and only that function", () => {
    expect(migration).toContain(
      "DROP FUNCTION IF EXISTS public.get_live_directory_rankings();",
    );
    // The period-aware successor must NOT be dropped/recreated (matched as a DROP/CREATE
    // statement, not a mere mention in comments).
    expect(migration).not.toMatch(
      /(?:DROP|CREATE OR REPLACE)\s+(?:FUNCTION|TABLE|VIEW)\b[^;]*get_live_directory_rankings_by_period/i,
    );
    // No re-creation of the legacy function.
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION\s+(?:public\.)?get_live_directory_rankings\(\)/i,
    );
  });

  it("does not touch other live RPCs", () => {
    expect(migration).not.toContain("get_live_directory_streamers");
    expect(migration).not.toContain("get_live_directory_active_streamer_ids");
    expect(migration).not.toMatch(
      /DROP\s+(FUNCTION|TABLE|VIEW)\s+(IF EXISTS\s+)?(?:public\.)?get_live_directory_rankings_by_period/i,
    );
  });
});
