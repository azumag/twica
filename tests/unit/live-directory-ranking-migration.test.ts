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
const rankingFunctionStart = migration.indexOf(
  "CREATE OR REPLACE FUNCTION get_live_directory_rankings()",
);
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
    const identityExpression = rankingFunction.match(
      /'identity',\s*CASE WHEN selected\.publish_stats THEN jsonb_build_object\(([\s\S]*?)\) ELSE NULL END/i,
    );

    expect(identityExpression).not.toBeNull();
    expect(identityExpression?.[1]).toContain("'twitchLogin', selected.twitch_username");
    expect(identityExpression?.[1]).toContain("'displayName', selected.twitch_display_name");
    expect(identityExpression?.[1]).toContain(
      "'profileImageUrl', selected.twitch_profile_image_url",
    );
    expect(
      [...(identityExpression?.[1].matchAll(/'([^']+)'/g) ?? [])].map((match) => match[1]),
    ).toEqual(["twitchLogin", "displayName", "profileImageUrl"]);
    expect(identityExpression?.[1]).not.toMatch(/streamerId|\bs\.id\b/i);
    expect(rankingFunction).not.toContain("'streamerId'");
    expect(rankingFunction).not.toContain("'twitchUserId'");
  });

  it("returns only positive top-100 candidates without ordering by an internal id", () => {
    // 各指標を独立に絞ることで、あるランキングの上位行が別指標の100件枠を
    // 消費せず、ゼロ値の行も公開候補へ混入しない契約を固定する。
    expect(rankingFunction).toMatch(
      /r\.card_count > 0 AND r\.card_count_position <= 100/i,
    );
    expect(rankingFunction).toMatch(
      /r\.redemption_count > 0 AND r\.redemption_count_position <= 100/i,
    );
    expect(rankingFunction).toMatch(
      /r\.total_points > 0 AND r\.total_points_position <= 100/i,
    );
    expect(rankingFunction).toMatch(
      /WHERE CARDINALITY\(selected\.ranked_metrics\) > 0/i,
    );
    expect(rankingFunction).not.toMatch(/ORDER BY[\s\S]*?\bs\.id\b/i);
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

  it("does not change the existing live RPC shape during the deploy window", () => {
    expect(rankingFunctionStart).toBeGreaterThanOrEqual(0);
    expect(migration).not.toContain(
      "CREATE OR REPLACE FUNCTION get_live_directory_streamers()",
    );
  });
});
