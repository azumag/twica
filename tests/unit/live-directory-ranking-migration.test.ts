import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260811120000_add_live_directory_rankings.sql",
  ),
  "utf8",
);
const liveFunctionStart = migration.indexOf(
  "CREATE OR REPLACE FUNCTION get_live_directory_streamers()",
);
const rankingFunctionStart = migration.indexOf(
  "CREATE OR REPLACE FUNCTION get_live_directory_rankings()",
);
const liveFunction = migration.slice(liveFunctionStart, rankingFunctionStart);
const rankingFunction = migration.slice(rankingFunctionStart);

describe("live directory ranking migration", () => {
  it("aggregates the three ranking metrics for every active streamer", () => {
    expect(rankingFunction).toContain(
      "CREATE OR REPLACE FUNCTION get_live_directory_rankings()",
    );
    expect(rankingFunction).toMatch(/COUNT\(\*\)::INTEGER AS card_count/i);
    expect(rankingFunction).toMatch(/SUM\(us\.redemption_count\)/i);
    expect(rankingFunction).toMatch(/SUM\(us\.total_points\)/i);
    expect(rankingFunction).toMatch(/WHERE s\.is_active = TRUE/i);
    expect(rankingFunction).not.toMatch(/WHERE s\.publish_live_status = TRUE/i);
  });

  it("removes every channel identifier when ranking identity is not opted in", () => {
    expect(rankingFunction).toMatch(
      /'identity',\s*CASE WHEN s\.publish_stats THEN jsonb_build_object\([\s\S]*?\) ELSE NULL END/i,
    );
    expect(rankingFunction).toContain("'streamerId', s.id");
    expect(rankingFunction).toContain("'twitchLogin', s.twitch_username");
    expect(rankingFunction).not.toContain("'twitchUserId'");
  });

  it("keeps the security-definer RPC service-role only", () => {
    expect(rankingFunction).toMatch(/SECURITY DEFINER\s+SET search_path = public/i);
    expect(rankingFunction).toContain(
      "REVOKE ALL ON FUNCTION get_live_directory_rankings() FROM PUBLIC;",
    );
    expect(rankingFunction).toContain(
      "GRANT EXECUTE ON FUNCTION get_live_directory_rankings() TO service_role;",
    );
  });

  it("keeps live consent filtering while removing legacy stats aggregation", () => {
    expect(liveFunctionStart).toBeGreaterThanOrEqual(0);
    expect(rankingFunctionStart).toBeGreaterThan(liveFunctionStart);
    expect(liveFunction).toMatch(/WHERE s\.publish_live_status = TRUE/i);
    expect(liveFunction).toContain("'twitchUserId', s.twitch_user_id");
    expect(liveFunction).not.toContain("channel_point_usage_stats");
    expect(liveFunction).not.toContain("'cardCount'");
    expect(liveFunction).not.toContain("'publishStats'");
  });
});
