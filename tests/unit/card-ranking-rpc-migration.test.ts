import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "db/planetscale/migrations/20261015040000_add_card_ranking_rpc.sql",
  ),
  "utf8",
);

/**
 * コメント行を除去したコード本文。正本（既存述語・同率決定順）の文言が「説明文
 * の中」にだけ残っていたり、逆に旧述語が本文に残っていたりしないかを判定する。
 */
const codeOnly = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

const fnBody = migration.match(
  /CREATE OR REPLACE FUNCTION public\.get_card_ranking\([\s\S]*?AS \$\$\n([\s\S]*?)\n\$\$;/,
)?.[1];
const body = fnBody ?? "";

describe("card ranking RPC migration (#934 / docs/features/doushi-card-corner.md §6)", () => {
  it("has the required PlanetScale transaction header", () => {
    expect(migration).toMatch(
      /^-- migration-transaction: required\n-- migration-providers: planetscale/,
    );
  });

  it("rejects unknown period and out-of-range limit fail-closed", () => {
    expect(body).toContain("v_period NOT IN ('all', '7d', '30d')");
    expect(body).toContain("RAISE EXCEPTION 'card_ranking: invalid period'");
    expect(body).toContain("RAISE EXCEPTION 'card_ranking: invalid limit'");
    // COALESCE で null period/limit を既定値へ落としてから検証する。
    expect(body).toContain("COALESCE(p_period, 'all')");
    expect(body).toContain("COALESCE(p_limit, 10)");
  });

  it("counts N連 with the authoritative predicate in every gacha_history scan", () => {
    // ①排出枚数 / ②使用チャネルポイント / ④人気カードの per_user 段、の3箇所。
    const predicate = "(history.reward_cost > 0 OR history.reward_id IS NOT NULL)";
    expect(codeOnly.split(predicate).length - 1).toBe(3);
    // 旧述語（reward_cost > 0 単独 / reward_id IS NOT NULL 単独）が本文に残っていないこと。
    expect(codeOnly).not.toMatch(/history\.reward_cost > 0\s*\)\s*$/m);
    expect(codeOnly).not.toMatch(/AND history\.reward_id IS NOT NULL(?! OR)/);
  });

  it("applies the shared exclusion to every grouped result (①②③④)", () => {
    // 除外判定は GROUP BY 後に適用する（2段構成 + OFFSET 0 フェンスの正本）。
    const exclusions = codeOnly.match(
      /WHERE NOT is_redemption_ranking_excluded\(/g,
    );
    expect(exclusions).toHaveLength(4);
    // ①②④ は per-user、③ は所持ベース。③ への適用は設計 §3 の推奨案（§7-8）。
    expect(codeOnly).toContain("WHERE NOT is_redemption_ranking_excluded(p_streamer_id, grouped.user_twitch_id)");
    expect(codeOnly).toContain("WHERE NOT is_redemption_ranking_excluded(p_streamer_id, held.user_twitch_id)");
    expect(codeOnly).toContain("WHERE NOT is_redemption_ranking_excluded(p_streamer_id, per_user.user_twitch_id)");
  });

  it("keeps the OFFSET 0 fence before each exclusion check", () => {
    // GROUP BY キーにのみ依存する述語はプランナが GROUP BY 前の行単位へ引き下げ
    // てしまうため、集約結果を OFFSET 0 で確定させてから除外判定する。
    expect(codeOnly.split("OFFSET 0").length - 1).toBeGreaterThanOrEqual(5);
  });

  it("encodes the §3.1 tie-break order in SQL (client never sorts)", () => {
    // ① 排出枚数
    expect(body).toMatch(
      /ORDER BY grouped\.redemption_count DESC,\s*grouped\.last_redeemed_at DESC,\s*grouped\.user_twitch_id ASC/,
    );
    // ② 使用チャネルポイント
    expect(body).toMatch(
      /ORDER BY grouped\.total_points DESC,\s*grouped\.redemption_count DESC,\s*grouped\.last_redeemed_at DESC,\s*grouped\.user_twitch_id ASC/,
    );
    // ③ 蒐集カード数
    expect(body).toMatch(
      /ORDER BY held\.unique_count DESC,\s*held\.draw_count DESC,\s*held\.user_twitch_id ASC/,
    );
    // ④ 人気カード
    expect(body).toMatch(
      /ORDER BY per_card\.actual_count DESC,\s*per_card\.drawer_count DESC,\s*per_card\.card_id ASC/,
    );
    // 各部門で ROW_NUMBER + `WHERE rn <= v_limit` により上位 limit 件だけを返す。
    expect(body.split("WHERE ranked.rn <= v_limit").length - 1).toBe(4);
  });

  it("returns only allowlisted fields (no user_twitch_id / card_id in the payload)", () => {
    const builtKeys = [...body.matchAll(/jsonb_build_object\(\s*'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    const allowed = new Set([
      "rank",
      "username",
      "redemption_count",
      "total_points",
      "unique_count",
      "total_cards",
      "card_name",
      "actual_count",
      "drawer_count",
      "generated_at",
      "period",
      "metric_labels",
      "note",
      "card_type_total",
      "by_count",
      "by_points",
      "by_unique",
      "popular_cards",
    ]);
    expect(builtKeys.length).toBeGreaterThan(0);
    for (const key of builtKeys) {
      expect(allowed.has(key)).toBe(true);
    }
    // 同率決定に使う id は関数内部でだけ参照し、オブジェクトへ積まない。
    expect(body).not.toMatch(/jsonb_build_object\(\s*'user_twitch_id'/);
    expect(body).not.toMatch(/jsonb_build_object\(\s*'card_id'/);
  });

  it("keeps ③ holdings-based (no period predicate) but adds card_type_total", () => {
    const uniqueSection = body.slice(
      body.indexOf("-- ③ 蒐集カード数"),
      body.indexOf("-- 母数"),
    );
    expect(uniqueSection.length).toBeGreaterThan(0);
    // ③ だけは period で切らない（全期間の所持ベース）。
    expect(uniqueSection).not.toContain("v_from");
    expect(uniqueSection).toContain("c.is_active = true");
    // 母数は is_active のみ。
    expect(body).toContain("WHERE streamer_id = p_streamer_id AND is_active = true");
  });

  it("ships metric_labels for all four metrics so docich never owns the copy", () => {
    for (const label of [
      "'by_count', '排出枚数'",
      "'by_points', '使用チャネルポイント'",
      "'by_unique', '蒐集カード数'",
      "'popular_cards', '人気カード'",
    ]) {
      expect(codeOnly).toContain(label);
    }
  });

  it("is SECURITY DEFINER with a fixed search_path and no public EXECUTE", () => {
    expect(migration).toMatch(
      /LANGUAGE plpgsql SECURITY DEFINER\s+SET search_path TO 'public'/,
    );
    expect(codeOnly).toContain(
      "REVOKE ALL ON FUNCTION public.get_card_ranking(uuid, text, integer) FROM PUBLIC;",
    );
    expect(codeOnly).toContain(
      "GRANT EXECUTE ON FUNCTION public.get_card_ranking(uuid, text, integer) TO service_role;",
    );
  });
});

// ---------------------------------------------------------------------------
// #934 公開オプトイン（20261015050000）: 集計（get_card_ranking）と公開ゲート
// （publish_card_ranking + get_published_card_ranking）を分離する。
// ---------------------------------------------------------------------------
const optInMigration = readFileSync(
  join(
    process.cwd(),
    "db/planetscale/migrations/20261015050000_add_card_ranking_optin.sql",
  ),
  "utf8",
);

const optInCodeOnly = optInMigration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("card ranking opt-in migration (#934)", () => {
  it("adds the opt-in column with DEFAULT FALSE and documents it", () => {
    expect(optInMigration).toMatch(
      /ALTER TABLE streamers\s+ADD COLUMN IF NOT EXISTS publish_card_ranking BOOLEAN NOT NULL DEFAULT FALSE;/,
    );
    expect(optInMigration).toContain(
      "COMMENT ON COLUMN streamers.publish_card_ranking IS",
    );
    // 既定OFF と UI 無しの方針が migration 本文に残っていること。
    expect(optInMigration).toContain("既定OFF");
    expect(optInMigration).toContain("ユーザー向けの設定画面は追加しない");
  });

  it("enables only the docich channel initially via a case-insensitive login match", () => {
    expect(optInCodeOnly).toMatch(
      /UPDATE streamers\s+SET publish_card_ranking = TRUE\s+WHERE lower\(twitch_username\) = 'dociai';/,
    );
  });

  it("gates publication in the DB and fails closed with P0002", () => {
    expect(optInCodeOnly).toContain(
      "CREATE OR REPLACE FUNCTION public.get_published_card_ranking(",
    );
    expect(optInCodeOnly).toContain("s.publish_card_ranking");
    expect(optInCodeOnly).toContain(
      "RAISE EXCEPTION 'card_ranking: not published' USING ERRCODE = 'P0002';",
    );
    // 未 opt-in と未知の streamer を区別しない（探索防止）ため、id 必須の例外も同じ code。
    expect(optInCodeOnly).toContain(
      "RAISE EXCEPTION 'card_ranking: streamer id is required' USING ERRCODE = 'P0002';",
    );
    // ゲート迂回の遮断: 集計本体は wrapper からのみ到達させる。
    expect(optInCodeOnly).toContain(
      "REVOKE EXECUTE ON FUNCTION public.get_card_ranking(uuid, text, integer) FROM service_role;",
    );
  });

  it("grants EXECUTE only to service_role on the wrapper", () => {
    expect(optInCodeOnly).toContain(
      "REVOKE ALL ON FUNCTION public.get_published_card_ranking(uuid, text, integer) FROM PUBLIC;",
    );
    expect(optInCodeOnly).toContain(
      "GRANT EXECUTE ON FUNCTION public.get_published_card_ranking(uuid, text, integer) TO service_role;",
    );
  });
});
