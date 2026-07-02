import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #578 (#576 Phase 1): per-pack rarity weight foundation — new columns,
// their CHECK constraints, and the rename_card_pack cascade extension. Like
// pack-rename-and-default-name-migration.test.ts (00063), these are static
// regex assertions on the SQL text, NOT a live DB execution.
describe("pack rarity weights migration (00065)", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../supabase/migrations/00065_add_pack_rarity_weights.sql"),
    "utf8"
  );

  describe("(a) streamers.rarity_weights_scope", () => {
    it("adds the column as NOT NULL defaulting to 'global'", () => {
      expect(sql).toMatch(
        /ADD COLUMN IF NOT EXISTS rarity_weights_scope TEXT NOT NULL DEFAULT 'global'/i
      );
    });

    it("idempotently re-applies the CHECK constraint (drop before add)", () => {
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS streamers_rarity_weights_scope_valid/i);
      expect(sql).toMatch(/ADD CONSTRAINT streamers_rarity_weights_scope_valid/i);
    });

    it("restricts values to 'global' or 'per_pack'", () => {
      expect(sql).toMatch(
        /CHECK \(rarity_weights_scope IN \('global', 'per_pack'\)\)/i
      );
    });
  });

  describe("(b) streamers.pack_rarity_weights", () => {
    it("adds the column as nullable JSONB defaulting to NULL", () => {
      expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS pack_rarity_weights JSONB DEFAULT NULL/i);
    });

    describe("check_pack_rarity_weights_values function", () => {
      it("is created with the correct signature", () => {
        expect(sql).toMatch(
          /CREATE OR REPLACE FUNCTION check_pack_rarity_weights_values\(weights JSONB\)\s*\n\s*RETURNS BOOLEAN\s*\n\s*LANGUAGE plpgsql\s*\n\s*IMMUTABLE/i
        );
      });

      it("treats NULL as valid (TRUE)", () => {
        expect(sql).toMatch(/IF weights IS NULL THEN\s*\n\s*RETURN TRUE;/i);
      });

      it("rejects non-object top-level values", () => {
        expect(sql).toMatch(/IF jsonb_typeof\(weights\) <> 'object' THEN\s*\n\s*RETURN FALSE;/i);
      });

      it("rejects more than 51 entries (50 packs + __default__)", () => {
        expect(sql).toMatch(/entry_count > 51/);
      });

      it("explicitly checks each entry is an object before delegating to check_rarity_weights_values (which returns TRUE for NULL)", () => {
        expect(sql).toMatch(/check_rarity_weights_values\(NULL\) は TRUE を返す/);
        expect(sql).toMatch(/IF jsonb_typeof\(entry_value\) <> 'object' THEN\s*\n\s*RETURN FALSE;/i);
      });

      it("delegates per-entry numeric/bounds validation to check_rarity_weights_values", () => {
        expect(sql).toMatch(/IF NOT check_rarity_weights_values\(entry_value\) THEN\s*\n\s*RETURN FALSE;/i);
      });

      it("documents that catalog key-existence validation is an app-layer concern (mirrors 00025/00062)", () => {
        expect(sql).toMatch(/app-layer/i);
        expect(sql).toMatch(/00062/);
      });
    });

    it("idempotently re-applies the CHECK constraint (drop before add)", () => {
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS streamers_pack_rarity_weights_valid/i);
      expect(sql).toMatch(
        /ADD CONSTRAINT streamers_pack_rarity_weights_valid\s*\n\s*CHECK \(check_pack_rarity_weights_values\(pack_rarity_weights\)\)/i
      );
    });
  });

  describe("(c) rename_card_pack cascade extension", () => {
    it("is (re-)created with the same signature and return type as 00063", () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.rename_card_pack\(\s*p_streamer_id UUID,\s*p_old_name TEXT,\s*p_new_name TEXT\s*\)\s*RETURNS void/i
      );
    });

    it("keeps SECURITY INVOKER with a locked-down search_path", () => {
      expect(sql).toMatch(/SECURITY INVOKER/i);
      expect(sql).toMatch(/SET search_path = ''/);
    });

    it("preserves all original validation/cascades from 00063", () => {
      expect(sql).toMatch(/RAISE EXCEPTION 'STREAMER_NOT_FOUND'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'INVALID_NEW_NAME'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'RESERVED_NEW_NAME'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'OLD_NEW_NAME_IDENTICAL'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'OLD_NAME_NOT_FOUND'/);
      expect(sql).toMatch(/RAISE EXCEPTION 'NEW_NAME_ALREADY_EXISTS'/);
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

    it("adds an atomic move of the pack_rarity_weights entry from old name to new name", () => {
      expect(sql).toMatch(
        /UPDATE public\.streamers\s+SET pack_rarity_weights = \(pack_rarity_weights - p_old_name\) \|\| jsonb_build_object\(v_new_name, pack_rarity_weights -> p_old_name\)\s+WHERE id = p_streamer_id AND pack_rarity_weights \? p_old_name/i
      );
    });

    it("references #576/#578 in the cascade rationale", () => {
      expect(sql).toMatch(/#576\/#578|#578\/#576|Issue #578/);
    });

    it("still documents collection_completions as an explicit, deliberate follow-up (#557), not touched here", () => {
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

  it("does not trigger any drop_rate recalculation (Phase 1 is storage-only; effective weights are computed at draw time in Phase 2)", () => {
    expect(sql).not.toMatch(/drop_rate\s*=/i);
    expect(sql).not.toMatch(/batch_update_card_drop_rates/i);
  });
});
