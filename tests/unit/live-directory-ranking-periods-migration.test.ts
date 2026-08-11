import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "db/planetscale/migrations/20260811130000_add_live_directory_ranking_periods.sql",
  ),
  "utf8",
);

describe("live directory ranking periods migration", () => {
  it("adds a backward-compatible period RPC for PlanetScale", () => {
    expect(migration).toMatch(
      /^-- migration-transaction: required\n-- migration-providers: planetscale/,
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION get_live_directory_rankings_by_period()",
    );
    expect(migration).not.toMatch(
      /CREATE OR REPLACE FUNCTION get_live_directory_rankings\(\)/,
    );
  });

  it("uses one seven-day boundary for cards, redemptions, and points", () => {
    // 境界時刻をparameters CTEへ一元化し、同じレスポンス内で指標ごとの期間が
    // 数ミリ秒ずれる回帰を防ぐ。
    expect(migration).toMatch(
      /CURRENT_TIMESTAMP - INTERVAL '7 days' AS last_7_days_start/i,
    );
    expect(migration).toMatch(
      /c\.created_at >= parameters\.last_7_days_start/i,
    );
    expect(migration).toMatch(
      /history\.redeemed_at >= parameters\.last_7_days_start/i,
    );
    expect(migration).toMatch(/history\.reward_cost > 0/i);
    expect(migration).toMatch(/SUM\(history\.reward_cost\)/i);
  });

  it("keeps existing all-time semantics without scanning all redemption history", () => {
    expect(migration).toMatch(
      /COUNT\(\*\) FILTER \(WHERE c\.is_active = TRUE\)::INTEGER AS all_time_card_count/i,
    );
    expect(migration).toMatch(/FROM channel_point_usage_stats usage/i);
    expect(migration).toMatch(/SUM\(usage\.redemption_count\)/i);
    expect(migration).toMatch(/SUM\(usage\.total_points\)/i);
  });

  it("ranks each period independently and returns both period keys", () => {
    expect(migration.match(/PARTITION BY periodized\.period/g)).toHaveLength(3);
    expect(migration).toMatch(
      /ranked\.card_count > 0 AND ranked\.card_count_position <= 100/i,
    );
    expect(migration).toMatch(
      /ranked\.redemption_count > 0 AND ranked\.redemption_count_position <= 100/i,
    );
    expect(migration).toMatch(
      /ranked\.total_points > 0 AND ranked\.total_points_position <= 100/i,
    );
    expect(migration).toContain("VALUES ('last7Days'::TEXT, 1), ('allTime'::TEXT, 2)");
    expect(migration).toMatch(/jsonb_object_agg\(/i);
  });

  it("removes identity unless opted in and keeps the RPC service-role only", () => {
    const identityExpression = migration.match(
      /'identity',\s*CASE WHEN selected\.publish_stats THEN jsonb_build_object\(([\s\S]*?)\) ELSE NULL END/i,
    );

    expect(identityExpression).not.toBeNull();
    expect(
      [...(identityExpression?.[1].matchAll(/'([^']+)'/g) ?? [])].map(
        (match) => match[1],
      ),
    ).toEqual(["twitchLogin", "displayName", "profileImageUrl"]);
    expect(migration).not.toContain("'streamerId'");
    expect(migration).not.toContain("'twitchUserId'");
    expect(migration).toMatch(/SECURITY DEFINER\s+SET search_path = public/i);
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION get_live_directory_rankings_by_period() FROM PUBLIC;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION get_live_directory_rankings_by_period() TO service_role;",
    );
  });
});
