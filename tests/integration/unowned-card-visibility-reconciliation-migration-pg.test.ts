// 未所持カード公開設定の整合 migration（Issue #2112）を実 PostgreSQL で検証する
// 挙動テスト。
//
// 背景:
// この migration は、旧 show_unowned_card_details と新3列
// (show_unowned_card_name / show_unowned_card_image / show_unowned_card_description)
// が食い違う既存行だけを UPDATE する。SQL 文字列の unit テストでは
//   - (a) details=false + 新3列すべて true の行だけが全 false になること
//   - (b) details=true + 新3列不揃いの行だけが全 true になること
//   - 正当な部分公開や整合済みの行が変わらないこと
//   - 再実行で値が変わらないこと（冪等）
// を実際の PostgreSQL 三値論理・UPDATE 条件で確認できない。
// このスイートは migration ファイル自体を読み、seed した食い違い行へ再適用する。
// CI では全 migration を空 DB へ適用した後に実行するため、ここでファイルを
// 再実行しても履歴テーブルや本番データには触れず、冪等性の検証にもなる。
//
// 専用の使い捨て PostgreSQL のみで実行する。共有 DB を
// UNOWNED_RECONCILIATION_TEST_DATABASE_URL に指定してはならない。変数が無ければ
// スイート全体をスキップする。
//
// ローカル実行例:
//   ci.yml の "Apply PlanetScale baseline and additive migrations" と同じ手順で
//   baseline・grants・全 migration を適用した後、次を実行する。
//   UNOWNED_RECONCILIATION_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
//     npx vitest run tests/integration/unowned-card-visibility-reconciliation-migration-pg.test.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.UNOWNED_RECONCILIATION_TEST_DATABASE_URL;
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null;

const MIGRATION_FILE = "20261126120000_reconcile_unowned_card_visibility_items.sql";
const migrationSql = readFileSync(
  resolve(process.cwd(), "db/planetscale/migrations", MIGRATION_FILE),
  "utf8"
);

// 使い捨てDB内でこのスイートの行だけを確実に識別する prefix。
// LIKE 検索に使うため、ワイルドカード意味を持たない文字列に限定している。
const PREFIX = "unowned-reconcile-2112-";

interface SeedRow {
  key: string;
  master: boolean;
  details: boolean;
  name: boolean;
  image: boolean;
  description: boolean;
}

type StoredRow = SeedRow;
type StoredDbRow = Omit<SeedRow, "key"> & { twitch_user_id: string };

/** UUID の version/variant nibble を保った deterministic id。 */
function idFor(index: number): string {
  return `7a211200-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const seedRows: SeedRow[] = [
  {
    // (a): 旧アプリで詳細公開を OFF にした行。resolver 規則 c の対象。
    key: "case-a-legacy-off",
    master: true,
    details: false,
    name: true,
    image: true,
    description: true,
  },
  {
    // マスタースイッチは補正条件に入れない。false でも同じ食い違いは揃える。
    key: "case-a-master-off",
    master: false,
    details: false,
    name: true,
    image: true,
    description: true,
  },
  {
    // (b): 旧列 true（=旧アプリでは全公開）なのに部分公開になっている行。
    key: "case-b-partial",
    master: true,
    details: true,
    name: true,
    image: false,
    description: true,
  },
  {
    // (b): 旧アプリが旧列だけを ON にし、新3列が既定 false のまま残った行。
    key: "case-b-all-false",
    master: true,
    details: true,
    name: false,
    image: false,
    description: false,
  },
  {
    // 新アプリが正当に作りうる部分公開。details=false はミラー結果なので触らない。
    key: "control-legitimate-partial",
    master: true,
    details: false,
    name: true,
    image: false,
    description: false,
  },
  {
    // 整合済み（全非公開）。
    key: "control-consistent-hidden",
    master: true,
    details: false,
    name: false,
    image: false,
    description: false,
  },
  {
    // 整合済み（全公開）。
    key: "control-consistent-visible",
    master: true,
    details: true,
    name: true,
    image: true,
    description: true,
  },
];

async function cleanup() {
  if (!sql) return;
  await sql`DELETE FROM streamers WHERE twitch_user_id LIKE ${`${PREFIX}%`}`;
}

async function applyMigration() {
  // ファイル全体を実行する（UPDATE をコピーすると、テストが migration 本体と
  // 食い違っても検出できないため）。複数文は postgres.js の simple query として
  // 実行され、CI の psql 適用と同じ SQL 本文が対象になる。
  await sql!.unsafe(migrationSql);
}

async function readRows(): Promise<Record<string, StoredRow>> {
  const rows = await sql!<StoredDbRow[]>`
    SELECT twitch_user_id,
           show_unowned_cards AS "master",
           show_unowned_card_details AS "details",
           show_unowned_card_name AS "name",
           show_unowned_card_image AS "image",
           show_unowned_card_description AS "description"
    FROM streamers
    WHERE twitch_user_id LIKE ${`${PREFIX}%`}
    ORDER BY twitch_user_id`;
  expect(rows).toHaveLength(seedRows.length);
  return Object.fromEntries(
    rows.map((row) => {
      const key = String(row.twitch_user_id).slice(PREFIX.length);
      return [
        key,
        {
          key,
          master: row.master,
          details: row.details,
          name: row.name,
          image: row.image,
          description: row.description,
        } satisfies StoredRow,
      ] as [string, StoredRow];
    })
  );
}

describe.skipIf(!sql)("実 PostgreSQL での未所持カード公開設定整合 migration", () => {
  beforeAll(async () => {
    await cleanup();
    for (const [index, row] of seedRows.entries()) {
      // NOT NULL 列だけを明示し、残りは DB の DEFAULT に任せる。対象4列と
      // マスタースイッチはケースごとの前提値を明示する。
      await sql!`
        INSERT INTO streamers (
          id, twitch_user_id, twitch_username, twitch_display_name,
          show_unowned_cards, show_unowned_card_details, show_unowned_card_name,
          show_unowned_card_image, show_unowned_card_description
        ) VALUES (
          ${idFor(index)}, ${`${PREFIX}${row.key}`}, ${`${PREFIX}${row.key}`},
          ${`Unowned Reconcile ${row.key}`}, ${row.master}, ${row.details},
          ${row.name}, ${row.image}, ${row.description}
        )`;
    }
  });

  afterAll(async () => {
    await cleanup();
    await sql?.end();
  });

  let firstResult: Record<string, StoredRow> | undefined;

  it("食い違い (a)(b) だけを補正し、正当な部分公開と整合済み行を変更しない", async () => {
    await applyMigration();
    firstResult = await readRows();

    expect(firstResult).toEqual({
      // (a) は旧アプリの OFF を尊重して新3列をすべて false に揃える。
      // details とマスタースイッチは補正しない。
      "case-a-legacy-off": {
        key: "case-a-legacy-off",
        master: true,
        details: false,
        name: false,
        image: false,
        description: false,
      },
      "case-a-master-off": {
        key: "case-a-master-off",
        master: false,
        details: false,
        name: false,
        image: false,
        description: false,
      },
      // (b) は旧列 true の意味（3項目すべて公開）に合わせて新3列をすべて true にする。
      "case-b-partial": {
        key: "case-b-partial",
        master: true,
        details: true,
        name: true,
        image: true,
        description: true,
      },
      "case-b-all-false": {
        key: "case-b-all-false",
        master: true,
        details: true,
        name: true,
        image: true,
        description: true,
      },
      // 部分公開は新アプリの正当な状態なので変更しない。
      "control-legitimate-partial": {
        key: "control-legitimate-partial",
        master: true,
        details: false,
        name: true,
        image: false,
        description: false,
      },
      // 既に整合している行は変更しない。
      "control-consistent-hidden": {
        key: "control-consistent-hidden",
        master: true,
        details: false,
        name: false,
        image: false,
        description: false,
      },
      "control-consistent-visible": {
        key: "control-consistent-visible",
        master: true,
        details: true,
        name: true,
        image: true,
        description: true,
      },
    });
  });

  it("同じファイルを再実行しても全行が変わらない（冪等）", async () => {
    // 1回目の補正後は (a) の「すべて true」も (b) の「NOT (すべて true)」も
    // どの行も満たさない。同じファイルを再実行しても全行の公開設定が同じことを確認する。
    if (!firstResult) {
      throw new Error("冪等性の確認前に1回目の補正確認が完了していません");
    }
    await applyMigration();
    expect(await readRows()).toEqual(firstResult);
  });
});
