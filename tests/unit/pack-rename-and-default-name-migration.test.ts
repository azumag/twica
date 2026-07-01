import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #554: pack rename + default-pack display-name migration. Unit tests
// here are static regex checks against the SQL text (this repo's existing
// convention for migration tests — see card-pack-names-migration.test.ts /
// card-collection-migration.test.ts), NOT a live DB execution.
describe("pack rename + default pack name migration (00063)", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../supabase/migrations/00063_add_default_pack_name_and_rename.sql"),
    "utf8"
  );

  describe("(a) legacy-data collision guard", () => {
    it("scans cards.collection_name and streamers.card_pack_names for reserved `__`-prefixed values", () => {
      expect(sql).toMatch(/FROM public\.cards\s+WHERE collection_name LIKE '\\_\\_%' ESCAPE '\\'/i);
      expect(sql).toMatch(/jsonb_array_elements_text\(s\.card_pack_names\)/i);
    });

    it("raises an exception (aborts the migration) when legacy violations are found", () => {
      expect(sql).toMatch(/RAISE EXCEPTION/i);
    });

    it("does NOT scan channel_point_collection_name or the additional-rewards collection_name (both legitimately hold the sentinel post-#555)", () => {
      const guardBlockMatch = sql.match(/DO \$\$[\s\S]*?END\s*\$\$;/i);
      expect(guardBlockMatch).not.toBeNull();
      const guardBlock = guardBlockMatch![0];
      expect(guardBlock).not.toMatch(/channel_point_collection_name/i);
      expect(guardBlock).not.toMatch(/streamer_additional_gacha_rewards/i);
    });
  });

  describe("(b) cards.collection_name reserved-prefix CHECK constraint", () => {
    it("idempotently re-applies the constraint (drop before add)", () => {
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS cards_collection_name_not_reserved/i);
      expect(sql).toMatch(/ADD CONSTRAINT cards_collection_name_not_reserved/i);
    });

    it("allows NULL and rejects `__`-prefixed values", () => {
      expect(sql).toMatch(
        /collection_name IS NULL OR collection_name NOT LIKE '\\_\\_%' ESCAPE '\\'/i
      );
    });
  });

  describe("(c) streamers.default_card_pack_name", () => {
    it("adds the column as nullable text", () => {
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS default_card_pack_name TEXT NULL/i);
    });

    it("enforces a 1-80 char length bound (after trimming) when set, allowing NULL", () => {
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS streamers_default_card_pack_name_valid/i);
      expect(sql).toMatch(
        /default_card_pack_name IS NULL\s*\n\s*OR char_length\(btrim\(default_card_pack_name\)\) BETWEEN 1 AND 80/i
      );
    });
  });

  describe("(d) rename_card_pack function", () => {
    it("is created with the correct signature and return type", () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.rename_card_pack\(\s*p_streamer_id UUID,\s*p_old_name TEXT,\s*p_new_name TEXT\s*\)\s*RETURNS void/i
      );
    });

    it("uses SECURITY INVOKER with a locked-down search_path", () => {
      expect(sql).toMatch(/SECURITY INVOKER/i);
      expect(sql).toMatch(/SET search_path = ''/);
    });

    it("validates old-name membership, new-name format/reservation, and old<>new", () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'STREAMER_NOT_FOUND'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'INVALID_NEW_NAME'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'RESERVED_NEW_NAME'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'OLD_NEW_NAME_IDENTICAL'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'OLD_NAME_NOT_FOUND'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'NEW_NAME_ALREADY_EXISTS'/);
    });

    it("cascades the rename to cards, the main reward, and additional rewards", () => {
      expect(sql).toMatch(
        /UPDATE public\.cards\s+SET collection_name = v_new_name\s+WHERE streamer_id = p_streamer_id AND collection_name = p_old_name/i
      );
      expect(sql).toMatch(
        /UPDATE public\.streamers\s+SET channel_point_collection_name = v_new_name\s+WHERE id = p_streamer_id AND channel_point_collection_name = p_old_name/i
      );
      expect(sql).toMatch(
        /UPDATE public\.streamer_additional_gacha_rewards\s+SET collection_name = v_new_name\s+WHERE streamer_id = p_streamer_id AND collection_name = p_old_name/i
      );
    });

    it("updates the catalog entry in place via jsonb_set (preserves ordering)", () => {
      expect(sql).toMatch(/jsonb_set\(v_catalog, ARRAY\[v_old_index::text\], to_jsonb\(v_new_name\)\)/);
    });

    it("documents collection_completions as an explicit, deliberate follow-up (#557), not touched here", () => {
      expect(sql).toMatch(/#557/);
      expect(sql).not.toMatch(/UPDATE public\.collection_completions/i);
    });

    it("revokes EXECUTE from PUBLIC/anon/authenticated and grants only to service_role", () => {
      expect(sql).toMatch(
        /REVOKE ALL ON FUNCTION public\.rename_card_pack\(UUID, TEXT, TEXT\) FROM PUBLIC, anon, authenticated/i
      );
      expect(sql).toMatch(
        /GRANT EXECUTE ON FUNCTION public\.rename_card_pack\(UUID, TEXT, TEXT\) TO service_role/i
      );
    });
  });

  it("does not introduce permissive public RLS policies", () => {
    expect(sql).not.toMatch(/FOR ALL\s+USING\s*\(true\)/i);
    expect(sql).not.toMatch(/TO\s+authenticated/i);
    expect(sql).not.toMatch(/TO\s+anon/i);
  });
});
