import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Issue #2112: 新3列（名前・画像・説明）と旧 show_unowned_card_details が
// 食い違う行を整合させる migration の契約テスト。SQL テキストの静的アサーションで
// 対象条件・冪等性・触れてはいけない列を固定し、実DBでの各行挙動は
// tests/integration/unowned-card-visibility-reconciliation-migration-pg.test.ts が担う。
const MIGRATIONS_DIR = resolve(__dirname, "../../db/planetscale/migrations");
const MIGRATION_FILE = "20261126120000_reconcile_unowned_card_visibility_items.sql";
const ITEMS_MIGRATION_FILE = "20261122120000_add_unowned_card_visibility_items.sql";

const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");
const updateStatements = sql.match(/UPDATE public\.streamers[\s\S]*?;/g) ?? [];
const caseA = updateStatements[0] ?? "";
const caseB = updateStatements[1] ?? "";

describe(`未所持カード公開設定の整合 migration (${MIGRATION_FILE})`, () => {
  it("新3列を追加した migration より後に適用される", () => {
    // 補正対象の新3列が存在することは、ファイル名順適用で保証する。
    // 「最新である」ではなく「#2110 の列追加より後ろ」だけを固定し、
    // 将来さらに新しい migration が追加されてもこのテストを壊さない。
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
    expect(files.indexOf(MIGRATION_FILE)).toBeGreaterThan(files.indexOf(ITEMS_MIGRATION_FILE));
  });

  it("transactional な PlanetScale migration ヘッダーと #2111 の app-first 前提を宣言する", () => {
    // migration 自体は旧アプリを壊さないデータ補正だが、旧アプリが残っていると
    // 補正後に旧列だけを書き換えて食い違いを再発させうる。昇格時に #2111 の
    // 本番稼働確認を求める運用ゲートとして app-first ヘッダーを固定する。
    expect(sql).toMatch(
      /^-- migration-transaction: required\n-- migration-providers: planetscale\n-- app-first: #2111/
    );
  });

  it("UPDATE 文はちょうど2本で、どちらも public.streamers に限定される", () => {
    expect(updateStatements).toHaveLength(2);
    expect(sql.match(/UPDATE\s+[a-z_.]+/gi)).toEqual([
      "UPDATE public.streamers",
      "UPDATE public.streamers",
    ]);
  });

  it("case (a): details=false かつ新3列がすべて true の行だけ、新3列をすべて false にする", () => {
    // resolver 規則 c が非公開へ倒す行。残存 true を放置すると、次の部分保存で
    // ミラー式が旧 details を true に戻しうるため、3列とも false に揃える。
    expect(caseA).toMatch(
      /SET\s+show_unowned_card_name\s*=\s*false,\s*show_unowned_card_image\s*=\s*false,\s*show_unowned_card_description\s*=\s*false/i
    );
    expect(caseA).toMatch(
      /WHERE\s+show_unowned_card_details\s*=\s*false\s+AND\s+show_unowned_card_name\s*=\s*true\s+AND\s+show_unowned_card_image\s*=\s*true\s+AND\s+show_unowned_card_description\s*=\s*true/i
    );
  });

  it("case (b): details=true かつ新3列が不揃いの行だけ、新3列をすべて true にする", () => {
    // 旧列 true は旧アプリでは「3項目すべて公開」の意味。部分公開に見える
    // 新3列を残すと新旧で公開範囲が食い違うため、3列とも true に揃える。
    expect(caseB).toMatch(
      /SET\s+show_unowned_card_name\s*=\s*true,\s*show_unowned_card_image\s*=\s*true,\s*show_unowned_card_description\s*=\s*true/i
    );
    expect(caseB).toMatch(
      /WHERE\s+show_unowned_card_details\s*=\s*true\s+AND\s+NOT\s*\(\s*show_unowned_card_name\s*=\s*true\s+AND\s+show_unowned_card_image\s*=\s*true\s+AND\s+show_unowned_card_description\s*=\s*true\s*\)/i
    );
  });

  it("各補正後にはガード条件を満たさなくなり、再実行が no-op になる", () => {
    // (a) は「すべて true」条件、(b) は「NOT (すべて true)」条件を更新後に
    // それぞれ満たさなくなるため、再実行時は 0 行更新になる。
    // SET 句が false/true に分かれていることは上の case テストで固定済みで、
    // ここでは冪等性を支える WHERE 側のガードを明示的に固定する。
    expect(caseA).toMatch(/show_unowned_card_name\s*=\s*true/i);
    expect(caseA).toMatch(/show_unowned_card_image\s*=\s*true/i);
    expect(caseA).toMatch(/show_unowned_card_description\s*=\s*true/i);
    expect(caseB).toMatch(/NOT\s*\([\s\S]*show_unowned_card_description\s*=\s*true[\s\S]*\)/i);
  });

  it("旧 details 列とマスター表示スイッチを書き換えない", () => {
    // 旧列は旧アプリとの互換判定そのものなので補正しない。マスタースイッチも
    // 公開対象項目の整合とは独立した配信者設定なので触らない。
    for (const statement of updateStatements) {
      const setClause = statement.slice(statement.indexOf("SET"), statement.indexOf("WHERE"));
      expect(setClause).not.toMatch(/show_unowned_card_details\s*=/i);
      expect(setClause).not.toMatch(/show_unowned_cards\s*=/i);
    }
  });

  it("schema オブジェクトや無関係な行を触らない", () => {
    // データ補正のみ。DROP / DELETE / TRUNCATE / DDL を混ぜると、対象外行への
    // 影響や適用順序の前提が変わるため、この migration では禁止する。
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\s+FROM\b|\bTRUNCATE\b|\bALTER\s+TABLE\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|FUNCTION|INDEX)\b/i);
  });
});
