import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// #1765 フォローアップ: アルバム表示のパック別既定（並び N×N）と初期表示モードの
// migration。既存の migration テストと同じく SQL テキストへの静的アサーションで、
// 実DB実行ではない（実DB適用は CI の planetscale-migration-postgres が担う）。
describe("pack album settings migration (20261014120000)", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../db/planetscale/migrations/20261014120000_add_pack_album_settings.sql"
    ),
    "utf8"
  );

  describe("(a) streamers.pack_album_grid_sizes", () => {
    it("adds the column as nullable JSONB", () => {
      expect(sql).toMatch(
        /ADD COLUMN IF NOT EXISTS pack_album_grid_sizes JSONB DEFAULT NULL/i
      );
    });

    it("validates the map through a schema-qualified, search_path-locked function", () => {
      // rename_card_pack (SET search_path = '') が streamers を UPDATE すると
      // CHECK 制約経由でこの関数が空 search_path 下で実行されるため、
      // 修飾名 + search_path 固定でないと実行時名前解決に失敗する。
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.check_pack_album_grid_sizes_values\(sizes JSONB\)\s*\n\s*RETURNS BOOLEAN\s*\n\s*LANGUAGE plpgsql\s*\n\s*IMMUTABLE\s*\n\s*SET search_path = ''/i
      );
    });

    it("treats NULL as valid and rejects non-objects", () => {
      expect(sql).toMatch(/IF sizes IS NULL THEN\s*\n\s*RETURN TRUE;/i);
      expect(sql).toMatch(/IF jsonb_typeof\(sizes\) <> 'object' THEN\s*\n\s*RETURN FALSE;/i);
    });

    it("bounds the entry count for the 50-pack catalog plus reserved keys", () => {
      expect(sql).toMatch(/IF entry_count > 52 THEN/i);
    });

    it("requires an integer N within the UI range (3..12)", () => {
      expect(sql).toMatch(/IF \(entry_value\)::text !~ '\^\[0-9\]\+\$' THEN/i);
      expect(sql).toMatch(
        /IF \(entry_value\)::text::integer < 3 OR \(entry_value\)::text::integer > 12 THEN/i
      );
    });

    it("idempotently re-applies the CHECK constraint (drop before add)", () => {
      expect(sql).toMatch(
        /DROP CONSTRAINT IF EXISTS streamers_pack_album_grid_sizes_valid/i
      );
      expect(sql).toMatch(
        /ADD CONSTRAINT streamers_pack_album_grid_sizes_valid\s*\n\s*CHECK \(public\.check_pack_album_grid_sizes_values\(pack_album_grid_sizes\)\)/i
      );
    });
  });

  describe("(b) streamers.collection_default_view", () => {
    it("adds the column as NOT NULL defaulting to 'grid'", () => {
      expect(sql).toMatch(
        /ADD COLUMN IF NOT EXISTS collection_default_view TEXT NOT NULL DEFAULT 'grid'/i
      );
    });

    it("restricts values to 'grid' or 'album'", () => {
      expect(sql).toMatch(
        /DROP CONSTRAINT IF EXISTS streamers_collection_default_view_valid/i
      );
      expect(sql).toMatch(
        /ADD CONSTRAINT streamers_collection_default_view_valid\s*\n\s*CHECK \(collection_default_view IN \('grid', 'album'\)\)/i
      );
    });
  });

  describe("(c) rename_card_pack cascade", () => {
    it("redefines the rename RPC", () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.rename_card_pack\(\s*p_streamer_id UUID,\s*p_old_name TEXT,\s*p_new_name TEXT\s*\)\s*RETURNS void/i
      );
    });

    it("moves the pack's entry to the new name atomically (never both/neither)", () => {
      expect(sql).toMatch(
        /SET pack_album_grid_sizes = \(pack_album_grid_sizes - p_old_name\) \|\| jsonb_build_object\(p_new_name, pack_album_grid_sizes -> p_old_name\)/i
      );
      expect(sql).toMatch(
        /WHERE id = p_streamer_id AND pack_album_grid_sizes \? p_old_name/i
      );
    });

    it("keeps the existing cascades intact", () => {
      expect(sql).toMatch(/UPDATE public\.cards\s+SET collection_name = v_new_name/i);
      expect(sql).toMatch(/SET pack_rarity_weights = \(pack_rarity_weights - p_old_name\)/i);
      expect(sql).toMatch(/UPDATE public\.collection_completions\s+SET collection_name = v_new_name/i);
      expect(sql).toMatch(/UPDATE public\.pack_completion_rewards SET collection_name = v_new_name/i);
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
