import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";

// Issue #2045: {packUnique}/{packAll} 用に chatSnapshot.packCounts を保存する trigger の
// 契約テスト。既存の migration テストと同じく SQL テキストへの静的アサーションで、
// 集計結果・例外時の無加工返却などの実挙動は CI の planetscale-migration-postgres job で
// tests/fixtures/paced-multi-draw-chat-postgres.mjs が実 PostgreSQL 17 に対して検証する。
const MIGRATIONS_DIR = resolve(__dirname, "../../db/planetscale/migrations");
const MIGRATION_FILE = "20261115120000_chat_outbox_pack_counts_snapshot.sql";

const sql = readFileSync(resolve(MIGRATIONS_DIR, MIGRATION_FILE), "utf8");

/** コメントを落として空白を1つに潰す（書式差でなく意味の差だけを比べるため）。 */
const code = sql
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join(" ")
  .replace(/\s+/g, " ");

describe(`chat outbox pack counts migration (${MIGRATION_FILE})`, () => {
  it("sorts after the payload v2 RPC and the cardCounts snapshot trigger it builds on", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.indexOf(MIGRATION_FILE)).toBeGreaterThan(
      files.indexOf("20261031120000_chat_outbox_payload_version_2.sql")
    );
    expect(files.indexOf(MIGRATION_FILE)).toBeGreaterThan(
      files.indexOf("20260915113000_individual_multi_draw_single_template_snapshot.sql")
    );
  });

  it("declares the transactional planetscale header without app-first (order independent)", () => {
    expect(sql).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/);
    expect(sql).not.toMatch(/^-- app-first/m);
  });

  it("is additive: adds one trigger function and does not replace the gacha RPC", () => {
    expect(code).not.toContain("execute_gacha_transaction_with_chat_outbox");
    expect(code).toContain("CREATE OR REPLACE FUNCTION public.snapshot_chat_outbox_pack_counts()");
    expect(code).toContain(
      "DROP TRIGGER IF EXISTS zz_snapshot_chat_outbox_pack_counts ON public.chat_notification_outbox;"
    );
    expect(code).toContain(
      "CREATE TRIGGER zz_snapshot_chat_outbox_pack_counts BEFORE INSERT ON public.chat_notification_outbox FOR EACH ROW EXECUTE FUNCTION public.snapshot_chat_outbox_pack_counts();"
    );
  });

  it("restricts execution to service_role", () => {
    expect(code).toContain(
      "REVOKE ALL ON FUNCTION public.snapshot_chat_outbox_pack_counts() FROM PUBLIC, anon, authenticated;"
    );
    expect(code).toContain(
      "GRANT EXECUTE ON FUNCTION public.snapshot_chat_outbox_pack_counts() TO service_role;"
    );
  });

  it("aggregates only when either stored template contains a token (NULL = absent)", () => {
    for (const template of ["v_single_template", "v_multi_template"]) {
      for (const token of ["{packUnique}", "{packAll}"]) {
        expect(code).toContain(`coalesce(strpos(${template}, '${token}'), 0) > 0`);
      }
    }
    expect(code).toContain("NEW.payload #>> '{streamer,chat_announcement_template}'");
    expect(code).toContain("NEW.payload #>> '{streamer,chat_announcement_multi_template}'");
    // individual N連は単発テンプレートを使うため、delivery_mode / draw数では絞らない
    expect(code).not.toContain("delivery_mode");
    expect(code).not.toContain("expected_draw_count");
  });

  it("keys packs exactly like resolveCardPackKey on both the payload and the DB side", () => {
    expect(DEFAULT_PACK_SENTINEL).toBe("__default__");
    expect(code).toContain(
      "coalesce(nullif(drawn.card_payload ->> 'collection_name', ''), '__default__')"
    );
    expect(code).toContain("coalesce(nullif(c.collection_name, ''), '__default__')");
  });

  it("counts owned card types via EXISTS over active cards of the streamer", () => {
    expect(code).toMatch(/WHERE EXISTS \( SELECT 1 FROM public\.user_cards uc WHERE uc\.user_id = v_user_id AND uc\.card_id = c\.id \)/);
    expect(code).toContain("c.streamer_id = v_streamer_id AND c.is_active = true");
  });

  it("never lets an exception escape and never writes a NULL payload", () => {
    expect(code).toMatch(/EXCEPTION WHEN OTHERS THEN RAISE WARNING [^;]+; RETURN NEW; END;/);
    expect(code).toContain(
      "NEW.payload := jsonb_set( NEW.payload, '{chatSnapshot,packCounts}', coalesce(v_pack_counts, '{}'::jsonb), true );"
    );
    expect(code).toContain("jsonb_typeof(NEW.payload #> '{chatSnapshot}') IS DISTINCT FROM 'object'");
  });
});
