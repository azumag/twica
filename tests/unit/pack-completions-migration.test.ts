import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #557: per-pack collection completions migration. Static regex checks
// against the SQL text, following this repo's migration-test convention
// (see pack-rename-and-default-name-migration.test.ts) — NOT a live DB run.
describe("pack completions migration (00064)", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../supabase/migrations/00064_add_pack_completions.sql"),
    "utf8"
  );

  describe("(a) collection_completions.collection_name column", () => {
    it("adds the column idempotently as nullable text", () => {
      expect(sql).toMatch(
        /ALTER TABLE public\.collection_completions\s+ADD COLUMN IF NOT EXISTS collection_name TEXT NULL/i
      );
    });

    it("enforces a 1-80 char length bound (after trimming) when set, allowing NULL", () => {
      expect(sql).toMatch(
        /DROP CONSTRAINT IF EXISTS collection_completions_collection_name_length/i
      );
      expect(sql).toMatch(
        /collection_name IS NULL\s*\n\s*OR char_length\(btrim\(collection_name\)\) BETWEEN 1 AND 80/i
      );
    });

    it("does NOT ban the reserved `__` prefix on this column (DEFAULT_PACK_SENTINEL is a legitimate stored value here)", () => {
      // 00063 added cards_collection_name_not_reserved to cards; an equivalent
      // constraint here would reject correct data ("__default__" = the default
      // pack's completion record).
      expect(sql).not.toMatch(/ADD CONSTRAINT collection_completions\S*not_reserved/i);
    });
  });

  describe("(b) uniqueness: replace the 00030 UNIQUE constraint with two partial unique indexes", () => {
    it("drops the original inline UNIQUE constraint by catalog lookup (auto-generated name, not a hard-coded guess)", () => {
      expect(sql).toMatch(/FROM pg_constraint/i);
      expect(sql).toMatch(/c\.contype = 'u'/i);
      // Order-insensitive column-set match of the 00030 constraint.
      expect(sql).toMatch(
        /ARRAY\['streamer_id', 'total_cards', 'twitch_user_id'\]::name\[\]/
      );
      expect(sql).toMatch(/DROP CONSTRAINT %I/);
    });

    it("creates the overall partial unique index (collection_name IS NULL) preserving legacy semantics", () => {
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_completions_overall_unique\s+ON public\.collection_completions \(twitch_user_id, streamer_id, total_cards\)\s+WHERE collection_name IS NULL/i
      );
    });

    it("creates the pack-scoped partial unique index (collection_name IS NOT NULL)", () => {
      expect(sql).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_completions_pack_unique\s+ON public\.collection_completions \(twitch_user_id, streamer_id, collection_name, total_cards\)\s+WHERE collection_name IS NOT NULL/i
      );
    });
  });

  describe("(c) rename_card_pack completions cascade (the #557 follow-up deferred in 00063)", () => {
    it("re-creates the function with the same signature via CREATE OR REPLACE", () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.rename_card_pack\(\s*p_streamer_id UUID,\s*p_old_name TEXT,\s*p_new_name TEXT\s*\)\s*RETURNS void/i
      );
      expect(sql).toMatch(/SECURITY INVOKER/i);
      expect(sql).toMatch(/SET search_path = ''/);
    });

    it("keeps all of 00063's validations and cascades intact", () => {
      for (const code of [
        "STREAMER_NOT_FOUND",
        "INVALID_NEW_NAME",
        "RESERVED_NEW_NAME",
        "OLD_NEW_NAME_IDENTICAL",
        "OLD_NAME_NOT_FOUND",
        "NEW_NAME_ALREADY_EXISTS",
      ]) {
        expect(sql).toContain(`RAISE EXCEPTION '${code}'`);
      }
      expect(sql).toMatch(
        /UPDATE public\.cards\s+SET collection_name = v_new_name\s+WHERE streamer_id = p_streamer_id AND collection_name = p_old_name/i
      );
      expect(sql).toMatch(
        /UPDATE public\.streamers\s+SET channel_point_collection_name = v_new_name/i
      );
      expect(sql).toMatch(
        /UPDATE public\.streamer_additional_gacha_rewards\s+SET collection_name = v_new_name/i
      );
    });

    it("cascades completions: DELETEs old-name rows whose destination slot is occupied, then UPDATEs the rest", () => {
      expect(sql).toMatch(/DELETE FROM public\.collection_completions/i);
      expect(sql).toMatch(
        /UPDATE public\.collection_completions\s+SET collection_name = v_new_name\s+WHERE streamer_id = p_streamer_id AND collection_name = p_old_name/i
      );
    });

    it("runs the DELETE strictly before the UPDATE (unique-collision avoidance ordering)", () => {
      const deleteIndex = sql.search(/DELETE FROM public\.collection_completions/i);
      const updateIndex = sql.search(/UPDATE public\.collection_completions/i);
      expect(deleteIndex).toBeGreaterThan(-1);
      expect(updateIndex).toBeGreaterThan(-1);
      expect(deleteIndex).toBeLessThan(updateIndex);
    });

    it("scopes the collision DELETE to matching (twitch_user_id, total_cards) rows under the new name", () => {
      expect(sql).toMatch(/new_cc\.collection_name = v_new_name/);
      expect(sql).toMatch(/new_cc\.twitch_user_id = old_cc\.twitch_user_id/);
      expect(sql).toMatch(/new_cc\.total_cards = old_cc\.total_cards/);
    });

    it("references the deferred 00063 follow-up (#557)", () => {
      expect(sql).toMatch(/#557/);
    });

    it("re-asserts EXECUTE grants (service_role only)", () => {
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
