import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "db/planetscale/migrations/20260819120000_exclude_streamer_and_bot_from_redemption_rankings.sql",
  ),
  "utf8",
);

/**
 * コメント行を除去したコード本文。旧述語・単独reward_id条件が「説明文の中」
 * ではなく実際のSQL文として残っていないかを判定するのに使う
 * (ヘッダーコメントは意図的に旧述語・単独条件の文言を含むため、コード本文だけ
 * を見ないと誤検知/検知漏れになる)。
 */
const codeOnly = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("redemption ranking exclusions migration (streamer/bot exclusion + N連 fix)", () => {
  it("has the required PlanetScale transaction header", () => {
    expect(migration).toMatch(
      /^-- migration-transaction: required\n-- migration-providers: planetscale/,
    );
  });

  it("defines is_redemption_ranking_excluded with three EXISTS checks (self / streamer bot / system bot)", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.is_redemption_ranking_excluded\(([\s\S]*?)\$\$;/,
    );
    expect(fn).not.toBeNull();
    const body = fn![1];

    // 配信者本人
    expect(body).toMatch(
      /EXISTS \(\s*SELECT 1 FROM public\.streamers s\s*WHERE s\.id = p_streamer_id\s*AND s\.twitch_user_id = p_user_twitch_id\s*\)/,
    );
    // 配信者固有BOT
    expect(body).toMatch(
      /EXISTS \(\s*SELECT 1 FROM public\.twitch_bot_accounts b\s*WHERE b\.owner_type = 'streamer'\s*AND b\.streamer_id = p_streamer_id\s*AND b\.twitch_user_id = p_user_twitch_id\s*\)/,
    );
    // 共有(system)BOT
    expect(body).toMatch(
      /EXISTS \(\s*SELECT 1 FROM public\.twitch_bot_accounts b\s*WHERE b\.owner_type = 'system'\s*AND b\.twitch_user_id = p_user_twitch_id\s*\)/,
    );
    expect(body.match(/EXISTS \(/g)).toHaveLength(3);
    // 3条件はORで結ばれている(いずれか1つでも真なら除外)。ANDに改変されると
    // 除外がほぼ機能しなくなる致命的な回帰のため、OR区切りであることを固定する。
    expect(body.match(/\)\s*OR EXISTS \(/g)).toHaveLength(2);
    expect(body).not.toMatch(/\)\s*AND EXISTS \(/);

    // SECURITY DEFINER も SET search_path も付けない(インライン展開維持のため)
    expect(fn![0]).not.toMatch(/SECURITY DEFINER/);
    expect(fn![0]).not.toMatch(/SET search_path/);
  });

  it("applies the new predicate (reward_cost > 0 OR reward_id IS NOT NULL) everywhere N連 is counted, and drops the old predicate from executable SQL", () => {
    // trigger本体
    expect(codeOnly).toContain("AND (reward_cost > 0 OR reward_id IS NOT NULL);");
    // RPC ELSE分岐: total_points集計クエリ
    // RPC ELSE分岐: ranking集計クエリ
    expect(
      codeOnly.match(/AND \(reward_cost > 0 OR reward_id IS NOT NULL\)/g),
    ).toHaveLength(3); // trigger本体 + RPC 2クエリ
    // live 7日CTE (history.でqualifyされる)
    expect(codeOnly).toContain(
      "WHERE (history.reward_cost > 0 OR history.reward_id IS NOT NULL)",
    );
    // バックフィル (h.でqualifyされ、括弧なしの単独WHERE)
    expect(codeOnly).toContain("WHERE h.reward_cost > 0 OR h.reward_id IS NOT NULL");

    // 旧述語はヘッダーコメント(説明用)にのみ存在し、実行可能なSQL文には残っていない
    expect(codeOnly).not.toContain("reward_cost IS NOT NULL AND reward_cost > 0");
    expect(migration).toContain("reward_cost IS NOT NULL AND reward_cost > 0"); // ヘッダーの説明文には残す
  });

  it("never uses reward_id IS NOT NULL as a standalone condition outside comments (must always pair with reward_cost > 0 OR)", () => {
    const matches = [...codeOnly.matchAll(/reward_id IS NOT NULL/g)];
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const precedingText = codeOnly.slice(
        Math.max(0, match.index! - 40),
        match.index!,
      );
      // 直前が "reward_cost > 0 OR " であること。列名がテーブルエイリアスで
      // 修飾される箇所(history.reward_id / h.reward_id)も許容する。
      expect(precedingText).toMatch(/reward_cost > 0 OR (?:[a-z_][a-z0-9_]*\.)?$/i);
    }
  });

  it("refresh_channel_point_usage_stat calls is_redemption_ranking_excluded and deletes+returns early for excluded accounts", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.refresh_channel_point_usage_stat\(([\s\S]*?)\n\$\$;/,
    );
    expect(fn).not.toBeNull();
    const body = fn![1];

    expect(body).toMatch(
      /IF is_redemption_ranking_excluded\(p_streamer_id, p_user_twitch_id\) THEN\s*DELETE FROM channel_point_usage_stats\s*WHERE streamer_id = p_streamer_id\s*AND user_twitch_id = p_user_twitch_id;\s*RETURN;\s*END IF;/,
    );
    // 既存部分(SECURITY DEFINER, SET search_path, ON CONFLICT)は無変更
    expect(fn![0]).toMatch(/SECURITY DEFINER/);
    expect(fn![0]).toMatch(/SET search_path TO 'public'/);
    expect(fn![0]).toContain("ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET");
  });

  it("computes /live's 7-day usage with a two-stage GROUP BY (per-user, then per-streamer)", () => {
    expect(codeOnly).toContain(
      "GROUP BY history.streamer_id, history.user_twitch_id",
    );
    expect(codeOnly).toContain("GROUP BY per_user.streamer_id");
  });

  it("actually applies is_redemption_ranking_excluded at every read site (RPC total/ranking, /live), not just defines it", () => {
    // マイグレーションの主目的そのものなので、呼び出し箇所自体が消えていないか
    // (例えば関数定義だけ追加してHAVING/WHERE適用を消す退行)を直接固定する。
    // get_channel_point_usage_stats: 総合計サブクエリ側の除外
    expect(codeOnly).toContain(
      "WHERE NOT is_redemption_ranking_excluded(p_streamer_id, per_user.user_twitch_id);",
    );
    // get_channel_point_usage_stats: ranking側はGROUP BY後のHAVINGで除外
    expect(codeOnly).toContain(
      "HAVING NOT is_redemption_ranking_excluded(p_streamer_id, user_twitch_id)",
    );
    // /live: 2段GROUP BYの外側WHEREで除外
    expect(codeOnly).toContain(
      "WHERE NOT is_redemption_ranking_excluded(per_user.streamer_id, per_user.user_twitch_id)",
    );
  });

  it("keeps /live's existing non-excluded logic byte-for-byte (identity/ranking/anonymization untouched)", () => {
    expect(migration).toContain("FROM channel_point_usage_stats usage");
    expect(migration.match(/PARTITION BY periodized\.period/g)).toHaveLength(3);
    expect(migration).toContain(
      "VALUES ('last7Days'::TEXT, 1), ('allTime'::TEXT, 2)",
    );
    expect(migration.match(/CASE WHEN selected\.publish_stats/g)).toHaveLength(3);
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION get_live_directory_rankings_by_period()",
    );
    expect(migration).toContain(
      "COMMENT ON FUNCTION get_live_directory_rankings_by_period() IS\n  '/live向け直近7日間・全期間の各指標上位100件。publish_stats=falseは識別情報を返さない (issue #740)。配信者本人・登録済みBOTアカウントは集計から除外する';",
    );
  });

  it("backfills existing channel_point_usage_stats rows idempotently (delete excluded, then re-aggregate with the new predicate)", () => {
    expect(codeOnly).toMatch(
      /DELETE FROM channel_point_usage_stats s\s*WHERE is_redemption_ranking_excluded\(s\.streamer_id, s\.user_twitch_id\);/,
    );
    expect(codeOnly).toContain(
      "INSERT INTO channel_point_usage_stats (",
    );
    expect(codeOnly).toContain("ON CONFLICT (streamer_id, user_twitch_id) DO UPDATE SET");
  });

  it("registers the bot-account sync trigger scoped to identity-relevant column updates, and includes DELETE", () => {
    // DELETEを含めるのは必須: BOT連携解除(src/app/api/streamer/settings/route.ts
    // の disconnectBotAccountPg)は twitch_bot_accounts 行を物理DELETEする実経路。
    // DELETEを拾わないと解除後もランキングが除外されたまま復帰しない
    // (レビュー指摘: 必須-1)。
    expect(migration).toContain(
      "AFTER INSERT OR DELETE OR UPDATE OF twitch_user_id, streamer_id, owner_type",
    );
    expect(migration).toContain("ON public.twitch_bot_accounts");
    // OAuthトークンリフレッシュのたびに発火する無指定UPDATEトリガーが無いことを確認
    expect(migration).not.toMatch(/AFTER UPDATE ON public\.twitch_bot_accounts/);
    // OF句はUPDATEのみに掛かる構文であることを踏まえ、INSERT/DELETEが無条件で
    // 含まれていることも確認する(OF句がINSERT/DELETEまで絞り込んでしまう
    // 誤った書き方への回帰を防ぐ)。
    expect(migration).not.toMatch(/AFTER INSERT OR DELETE OF /);
    expect(migration).toContain(
      "DROP TRIGGER IF EXISTS trg_sync_channel_point_usage_stat_bot_account",
    );
  });

  it("sync_channel_point_usage_stat_for_bot_account guards OLD/NEW access by TG_OP (DELETE has no NEW, INSERT has no OLD)", () => {
    const fn = migration.match(
      /CREATE OR REPLACE FUNCTION public\.sync_channel_point_usage_stat_for_bot_account\(\)([\s\S]*?)\n\$\$;/,
    );
    expect(fn).not.toBeNull();
    const body = fn![1];

    // OLD参照はUPDATE/DELETEに限定(DELETEにはNEWが無いため、INSERT/UPDATEには含めない)
    expect(body).toMatch(
      /IF TG_OP IN \('UPDATE', 'DELETE'\) THEN\s*PERFORM refresh_channel_point_usage_stat\(s\.id, OLD\.twitch_user_id\)/,
    );
    // NEW参照はINSERT/UPDATEに限定(INSERTにはOLDが無いため、UPDATE/DELETEには含めない)
    expect(body).toMatch(
      /IF TG_OP IN \('INSERT', 'UPDATE'\) THEN\s*PERFORM refresh_channel_point_usage_stat\(s\.id, NEW\.twitch_user_id\)/,
    );
    // 無条件のTG_OP='UPDATE'一本槍(DELETEを取りこぼす旧実装)への回帰が無いことを確認
    expect(body).not.toMatch(/IF TG_OP = 'UPDATE' THEN/);
  });

  it("does not contain non-additive statements (no DROP FUNCTION/TABLE, no TRUNCATE)", () => {
    expect(migration).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("grants execute on the new/updated service-role-only functions", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.is_redemption_ranking_excluded(uuid, text) FROM PUBLIC;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.is_redemption_ranking_excluded(uuid, text) TO service_role;",
    );
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION get_live_directory_rankings_by_period() FROM PUBLIC;",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION get_live_directory_rankings_by_period() TO service_role;",
    );
  });
});
