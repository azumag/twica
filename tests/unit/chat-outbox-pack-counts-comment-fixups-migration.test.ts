import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Issue #2047: 適用済み migration の説明コメントは checksum で編集できないため、
// 後続 migration の COMMENT ON FUNCTION で訂正する運用の契約テスト。
// 訂正対象の関数・trigger 定義は正しいため、catalog comment だけを更新し、
// 関数本体や trigger を再定義しないことを固定する。
const MIGRATIONS_DIR = resolve(__dirname, "../../db/planetscale/migrations");
const MIGRATION_FILE = "20261115130000_chat_outbox_pack_counts_snapshot_comment_fixups.sql";
const CORRECTED_FILE = "20261115120000_chat_outbox_pack_counts_snapshot.sql";

const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

/** コメントを落として空白を1つに潰す（書式差でなく意味の差だけを比べるため）。 */
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ");

describe(`chat outbox pack counts comment fixups migration (${MIGRATION_FILE})`, () => {
  it("sorts after the snapshot trigger migration it corrects", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.indexOf(MIGRATION_FILE)).toBeGreaterThan(files.indexOf(CORRECTED_FILE));
  });

  it("declares the transactional planetscale header without app-first (comment-only)", () => {
    expect(sql).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/);
    expect(sql).not.toMatch(/^-- app-first/m);
  });

  it("updates only the catalog comment and keeps function/trigger definitions untouched", () => {
    expect(code).toContain("COMMENT ON FUNCTION public.snapshot_chat_outbox_pack_counts()");
    // 訂正はコメントだけ。関数本体・trigger・権限を再定義すると適用順や
    // 権限付与の差分が生まれるため禁止する。
    expect(code).not.toContain("CREATE OR REPLACE FUNCTION");
    expect(code).not.toContain("CREATE TRIGGER");
    expect(code).not.toContain("REVOKE");
    expect(code).not.toContain("GRANT");
  });

  it("bounds catalog-lock waiting like other DDL migrations", () => {
    expect(code).toContain("SET LOCAL lock_timeout = '5s';");
  });
});
