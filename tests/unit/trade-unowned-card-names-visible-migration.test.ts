import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Issue #2070: トレード限定の「未所持カードの名前だけを公開する」設定列を追加する
// migration の契約テスト。既存の migration テストと同じく SQL テキストへの静的
// アサーションで、実DB実行ではない（実DB適用は CI の planetscale-migration-postgres が担う）。
const MIGRATIONS_DIR = resolve(__dirname, "../../db/planetscale/migrations");
const MIGRATION_FILE = "20261117120000_add_trade_unowned_card_names_visible.sql";
const PREVIOUS_NEWEST_FILE = "20261115130000_chat_outbox_pack_counts_snapshot_comment_fixups.sql";

const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

describe(`trade unowned card names visibility migration (${MIGRATION_FILE})`, () => {
  it("is newer than every pre-existing planetscale migration file", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
    expect(files.indexOf(MIGRATION_FILE)).toBeGreaterThan(files.indexOf(PREVIOUS_NEWEST_FILE));
  });

  it("declares the transactional planetscale migration header", () => {
    expect(sql).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/);
  });

  it("adds the column idempotently as NOT NULL boolean default false (no table rewrite, no backfill)", () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.streamers\s+ADD COLUMN IF NOT EXISTS trade_unowned_card_names_visible boolean NOT NULL DEFAULT false;/i
    );
  });

  it("documents the trade-only semantics on the column", () => {
    expect(sql).toMatch(/COMMENT ON COLUMN public\.streamers\.trade_unowned_card_names_visible IS/);
    const comment = sql.slice(sql.indexOf("COMMENT ON COLUMN public.streamers.trade_unowned_card_names_visible IS"));
    // 次回実装する可視性判定の前提（show_unowned_cards ON / show_unowned_card_details OFF、
    // 名前とレアリティのみ、画像と説明は非表示、コレクション画面は不変）を DB にも残す。
    for (const keyword of [
      "show_unowned_cards",
      "show_unowned_card_details",
      "トレード",
      "名前",
      "レアリティ",
      "画像",
      "コレクション",
    ]) {
      expect(comment).toContain(keyword);
    }
  });

  it("only adds the one column and does not touch other schema objects", () => {
    // この migration は add-only。DROP / FUNCTION 差し替え / 他テーブル変更を混ぜると
    // ロールバック互換や適用順序の前提が崩れるため、対象を明示的に固定する。
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(sql).not.toMatch(/ALTER TABLE public\.(?!streamers\b)/i);
  });
});
