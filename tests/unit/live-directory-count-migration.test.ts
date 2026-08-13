import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "db/planetscale/migrations/20260813000000_add_live_directory_active_streamer_ids.sql",
  ),
  "utf8",
);

describe("live directory active streamer ids migration (#951)", () => {
  it("adds a PlanetScale-only RPC that returns active streamer ids", () => {
    expect(migration).toMatch(
      /^-- migration-transaction: required\n-- migration-providers: planetscale/,
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION get_live_directory_active_streamer_ids()",
    );
    expect(migration).toMatch(/WHERE s\.is_active = TRUE/i);
    expect(migration).toMatch(/s\.twitch_user_id IS NOT NULL/i);
  });

  it("never returns identity fields", () => {
    expect(migration).not.toContain("'streamerId'");
    expect(migration).not.toContain("'twitchUsername'");
    expect(migration).not.toContain("'twitchDisplayName'");
    expect(migration).not.toContain("'twitchProfileImageUrl'");
    expect(migration).not.toContain("'publishStats'");
    expect(migration).toMatch(/jsonb_agg\(s\.twitch_user_id/i);
  });

  it("keeps the function service-role only and does not touch existing RPCs", () => {
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = public/i);
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION get_live_directory_active_streamer_ids() FROM PUBLIC;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION get_live_directory_active_streamer_ids() TO service_role;",
    );
    expect(migration).not.toContain(
      "CREATE OR REPLACE FUNCTION get_live_directory_streamers()",
    );
    expect(migration).not.toContain(
      "CREATE OR REPLACE FUNCTION get_live_directory_rankings()",
    );
    expect(migration).not.toContain(
      "CREATE OR REPLACE FUNCTION get_live_directory_rankings_by_period()",
    );
  });
});
