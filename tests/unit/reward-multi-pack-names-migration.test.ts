import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { MAX_REWARD_PACK_NAMES } from "@/lib/validation/collection-name";

// Issue #1994: 1つのチャネルポイント報酬に複数パックを割り当てる migration の契約テスト。
// 既存の migration テストと同じく SQL テキストへの静的アサーションで、実DB実行では
// ない（実DB適用は CI の planetscale-migration-postgres が担う）。
const MIGRATIONS_DIR = resolve(__dirname, "../../db/planetscale/migrations");
const MIGRATION_FILE = "20261108120000_add_reward_multi_pack_names.sql";
const PREVIOUS_RENAME_FILE = "20261014120000_add_pack_album_settings.sql";

const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

/** `CREATE OR REPLACE FUNCTION public.rename_card_pack ... AS $$ <body> $$;` の本体。 */
function renameBody(source: string): string {
  const match = source.match(
    /CREATE OR REPLACE FUNCTION public\.rename_card_pack\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/i
  );
  if (!match) throw new Error("rename_card_pack definition not found");
  return match[1];
}

/** コメントを落として空白を1つに潰す（書式差でなく意味の差だけを比べるため）。 */
function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

describe(`reward multi-pack names migration (${MIGRATION_FILE})`, () => {
  it("is the newest planetscale migration file when added (sorted after every existing one)", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.indexOf(MIGRATION_FILE)).toBeGreaterThan(files.indexOf(PREVIOUS_RENAME_FILE));
    expect(files.indexOf(MIGRATION_FILE)).toBeGreaterThan(
      files.indexOf("20261031120000_chat_outbox_payload_version_2.sql")
    );
  });

  it("declares the transactional planetscale migration header", () => {
    expect(sql).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/);
  });

  describe.each([
    ["streamers", "channel_point_pack_names", "streamers_channel_point_pack_names_valid"],
    [
      "streamer_additional_gacha_rewards",
      "reward_pack_names",
      "streamer_additional_gacha_rewards_reward_pack_names_valid",
    ],
  ])("%s.%s", (table, column, constraint) => {
    it("adds the column idempotently as NOT NULL JSONB with a constant '[]' default (no table rewrite, no backfill)", () => {
      expect(sql).toMatch(
        new RegExp(
          `ALTER TABLE public\\.${table}\\s+ADD COLUMN IF NOT EXISTS ${column} JSONB NOT NULL DEFAULT '\\[\\]'::jsonb;`,
          "i"
        )
      );
    });

    it("re-applies the array/length CHECK idempotently (drop before add)", () => {
      expect(sql).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${constraint};`, "i"));
      expect(sql).toMatch(
        new RegExp(
          `ADD CONSTRAINT ${constraint} CHECK \\(\\s*jsonb_typeof\\(${column}\\) = 'array'\\s+AND jsonb_array_length\\(${column}\\) <= (\\d+)\\s*\\)`,
          "i"
        )
      );
    });

    it("uses the same element cap as the application (MAX_REWARD_PACK_NAMES)", () => {
      const match = sql.match(
        new RegExp(`jsonb_array_length\\(${column}\\) <= (\\d+)`, "i")
      );
      expect(Number(match?.[1])).toBe(MAX_REWARD_PACK_NAMES);
    });

    // 既存の部分一致検知（isMissingCollectionNameColumn は "collection_name"、
    // isMissingCardPackNamesColumnError は "card_pack_names"）に新列名が巻き込まれると、
    // デプロイ窓で新列の欠落を旧列の欠落と誤認してフォールバックが崩れる。
    it("does not contain the substrings matched by existing missing-column detectors", () => {
      expect(column).not.toContain("collection_name");
      expect(column).not.toContain("card_pack_names");
    });
  });

  describe("rename_card_pack", () => {
    const body = renameBody(sql);
    const normalizedBody = normalize(body);

    it("redefines the RPC with the same signature, SECURITY INVOKER and a locked search_path", () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.rename_card_pack\(\s*p_streamer_id UUID,\s*p_old_name TEXT,\s*p_new_name TEXT\s*\)\s*RETURNS void\s*LANGUAGE plpgsql\s*SECURITY INVOKER\s*SET search_path = ''/i
      );
    });

    // 直前の定義（20261014120000）が行っていたカスケード・検証を1つも落とさない。
    // CREATE OR REPLACE は関数全体の差し替えなので、ここで欠けると既存機能
    // （コンプリート実績・報酬・アルバム既定などの引き継ぎ）が黙って退行する。
    it("keeps every statement of the previous definition (superset)", () => {
      const previous = renameBody(readFileSync(resolve(MIGRATIONS_DIR, PREVIOUS_RENAME_FILE), "utf8"));
      const statements = normalize(previous)
        .replace(/^.*?\bBEGIN\b/i, "")
        .replace(/\bEND;?\s*$/i, "")
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
      expect(statements.length).toBeGreaterThan(10);
      for (const statement of statements) {
        expect(normalizedBody).toContain(statement);
      }
    });

    it("cascades the rename into both new array columns, de-duplicating while preserving order", () => {
      for (const [table, column, scope] of [
        ["streamers", "channel_point_pack_names", "id = p_streamer_id"],
        ["streamer_additional_gacha_rewards", "reward_pack_names", "streamer_id = p_streamer_id"],
      ]) {
        const statement = normalizedBody.match(
          new RegExp(`UPDATE public\\.${table} SET ${column} = \\(.*?\\) WHERE ${scope} AND ${column} \\? p_old_name`, "i")
        );
        expect(statement, `${table}.${column} cascade`).not.toBeNull();
        expect(statement![0]).toMatch(/jsonb_array_elements_text\(\w+\) WITH ORDINALITY/i);
        expect(statement![0]).toMatch(/CASE WHEN \w+\.name = p_old_name THEN v_new_name ELSE \w+\.name END/i);
        expect(statement![0]).toMatch(/GROUP BY/i);
        expect(statement![0]).toMatch(/ORDER BY/i);
      }
    });

    it("still renames the legacy single-column mirrors (rollback compatibility)", () => {
      expect(normalizedBody).toContain(
        "UPDATE public.streamers SET channel_point_collection_name = v_new_name WHERE id = p_streamer_id AND channel_point_collection_name = p_old_name"
      );
      expect(normalizedBody).toContain(
        "UPDATE public.streamer_additional_gacha_rewards SET collection_name = v_new_name WHERE streamer_id = p_streamer_id AND collection_name = p_old_name"
      );
    });

    it("keeps the RPC executable only by service_role", () => {
      expect(sql).toMatch(
        /REVOKE ALL ON FUNCTION public\.rename_card_pack\(UUID, TEXT, TEXT\) FROM PUBLIC, anon, authenticated/i
      );
      expect(sql).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.rename_card_pack\(UUID, TEXT, TEXT\) TO service_role/i
      );
    });
  });
});
