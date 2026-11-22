import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Issue #2070 フォローアップ: 未所持カードの「項目別公開設定」（名前・画像・説明）を
// 追加する migration の契約テスト。既存の migration テストと同じく SQL テキストへの
// 静的アサーションで、実DB実行ではない（実DB適用は CI の
// planetscale-migration-postgres が担う）。
const MIGRATIONS_DIR = resolve(__dirname, "../../db/planetscale/migrations");
const MIGRATION_FILE = "20261122120000_add_unowned_card_visibility_items.sql";
const PREVIOUS_NEWEST_FILE = "20261117120000_add_trade_unowned_card_names_visible.sql";
const ITEM_COLUMNS = [
  "show_unowned_card_name",
  "show_unowned_card_image",
  "show_unowned_card_description",
] as const;

const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");
const backfill = sql.slice(
  sql.indexOf("UPDATE public.streamers"),
  sql.indexOf("COMMENT ON COLUMN")
);

/** 指定列の COMMENT ON COLUMN 文（終端のセミコロンまで）を取り出す。 */
function commentFor(column: string): string {
  const marker = `COMMENT ON COLUMN public.streamers.${column} IS`;
  const start = sql.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf(";", start) + 1);
}

describe(`unowned card visibility items migration (${MIGRATION_FILE})`, () => {
  it("is newer than every pre-existing planetscale migration file", () => {
    // 将来さらに新しい migration が増えても壊れないよう「最新である」ではなく
    // 「追加時点の最新（#2070 の migration）より後ろ」を固定する。
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
    expect(files.indexOf(MIGRATION_FILE)).toBeGreaterThan(files.indexOf(PREVIOUS_NEWEST_FILE));
  });

  it("declares the transactional planetscale migration header", () => {
    expect(sql).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/);
  });

  it("is additive only, so no app-first header is needed", () => {
    // 列追加と既定値バックフィルだけなので DB-first でよい
    // （docs/QA.md「migrationとアプリの適用順序」）。旧アプリは新列を参照しない。
    expect(sql).not.toMatch(/^--\s*app-first:/m);
  });

  it("adds exactly the three item columns idempotently as NOT NULL boolean default false", () => {
    for (const column of ITEM_COLUMNS) {
      expect(sql).toMatch(
        new RegExp(
          `ADD COLUMN IF NOT EXISTS ${column} boolean NOT NULL DEFAULT false`,
          "i"
        )
      );
    }
    // 対象外の列を増やしていないこと（PR1 のスコープを固定する）。
    const added = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((match) => match[1]);
    expect(added).toEqual([...ITEM_COLUMNS]);
  });

  it("backfills the current detail-visible rows so their audience-facing output does not change", () => {
    expect(sql).toMatch(/UPDATE public\.streamers\b/);
    expect(backfill).toMatch(
      /SET\s+show_unowned_card_name\s*=\s*true,\s*show_unowned_card_image\s*=\s*true,\s*show_unowned_card_description\s*=\s*true/i
    );
    // 旧設定で詳細まで見えていた行（show_unowned_cards AND show_unowned_card_details）
    // だけを対象にする。詳細フラグだけ true の行は旧画面でも非公開なので対象外。
    expect(backfill).toMatch(
      /WHERE\s+show_unowned_cards\s+AND\s+show_unowned_card_details\s+AND\s+NOT\s*\(\s*show_unowned_card_name\s+AND\s+show_unowned_card_image\s+AND\s+show_unowned_card_description\s*\)/i
    );
  });

  it("makes the backfill idempotent with the NOT (all three already true) guard", () => {
    // NOT (...) により再適用時は 0 行更新になり、同じ migration を
    // 再実行しても既存値を壊さない（冪等）。SET 対象も3列に限定する。
    const setClause = backfill.slice(backfill.indexOf("SET"), backfill.indexOf("WHERE"));
    const assigned = [...setClause.matchAll(/show_unowned_card_\w+\s*=\s*true/gi)];
    expect(assigned).toHaveLength(3);
    expect(setClause).not.toMatch(/show_unowned_cards\s*=/i);
    expect(setClause).not.toMatch(/show_unowned_card_details\s*=/i);
    expect(backfill).toMatch(/NOT\s*\(\s*show_unowned_card_name\s+AND\s+show_unowned_card_image\s+AND\s+show_unowned_card_description\s*\)/i);
  });

  it("documents the per-item semantics, shared exclusions and legacy compatibility on every column", () => {
    for (const column of ITEM_COLUMNS) {
      const comment = commentFor(column);
      for (const keyword of [
        "show_unowned_cards",
        "show_unowned_card_details",
        "ミラー",
        "HP",
        "攻撃",
        "防御",
        "速度",
        "スキル",
        "レアリティ",
        "表示番号",
      ]) {
        expect(comment).toContain(keyword);
      }
    }
  });

  it("documents that the description is collection-only and never shown in trade/auction", () => {
    const comment = commentFor("show_unowned_card_description");
    for (const keyword of ["説明", "コレクション", "トレード", "オークション"]) {
      expect(comment).toContain(keyword);
    }
  });

  it("does not touch other schema objects or remove the legacy columns", () => {
    // この migration は add-only。DROP / FUNCTION 差し替え / 他テーブル変更 /
    // 既存列の変更を混ぜると、旧アプリ互換と適用順序の前提が崩れる。
    // 旧 show_unowned_card_details と trade_unowned_card_names_visible は
    // 後続リリースまで残すため、削除・変更のいずれも行わない。
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
    expect(sql).not.toMatch(/CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION/i);
    expect(sql).not.toMatch(/CREATE TABLE|CREATE INDEX|DELETE FROM|TRUNCATE/i);
    expect(sql).not.toMatch(/ALTER TABLE\s+(?!public\.streamers\b)/i);
    expect(sql.match(/UPDATE\s+[a-z_.]+/gi)).toEqual(["UPDATE public.streamers"]);
  });
});
