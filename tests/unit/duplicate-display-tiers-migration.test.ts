import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #1782: 被りカードの表示段階しきい値の migration。
// 既存の migration テスト（pack-album-settings-migration.test.ts）と同じく
// SQL テキストへの静的アサーションで、実DB実行ではない
// （実DB適用は CI の planetscale-migration-postgres が担う）。
describe("duplicate display tiers migration (20261015120000)", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../db/planetscale/migrations/20261015120000_add_duplicate_display_tiers.sql"
    ),
    "utf8"
  );

  describe("(a) streamers.duplicate_display_tiers 列", () => {
    it("nullable JSONB として追加する（既定 = 機能OFF）", () => {
      expect(sql).toMatch(
        /ADD COLUMN IF NOT EXISTS duplicate_display_tiers JSONB DEFAULT NULL/i
      );
    });

    it("CHECK 制約は修飾名 + search_path 固定の検証関数経由にする", () => {
      expect(sql).toMatch(
        /CREATE OR REPLACE FUNCTION public\.check_duplicate_display_tiers_values\(tiers JSONB\)\s*\n\s*RETURNS BOOLEAN\s*\n\s*LANGUAGE plpgsql\s*\n\s*IMMUTABLE\s*\n\s*SET search_path = ''/i
      );
    });

    it("NULL を valid、非object を invalid とする", () => {
      expect(sql).toMatch(/IF tiers IS NULL THEN\s*\n\s*RETURN TRUE;/i);
      expect(sql).toMatch(/IF jsonb_typeof\(tiers\) <> 'object' THEN\s*\n\s*RETURN FALSE;/i);
    });

    it("レアリティ数の上限54（既定4種 + カスタム50件）を課す", () => {
      expect(sql).toMatch(/IF entry_count > 54 THEN/i);
    });

    it("キーはレアリティ名と同じ 1..40 文字に制限する", () => {
      expect(sql).toMatch(
        /IF char_length\(entry_key\) < 1 OR char_length\(entry_key\) > 40 THEN/i
      );
    });

    it("制御文字・Bidi override を含むキーを拒否する", () => {
      // テキスト正規表現では 0x00 / 0x9F を文字クラスに書けないため、
      // コードポイントの数値比較で判定する（ascii() はマルチバイトで
      // コードポイントを返すので Bidi override も同一比較で扱える）。
      expect(sql).toMatch(/ascii\(substr\(entry_key, char_offset, 1\)\) BETWEEN 0 AND 31/i);
      expect(sql).toMatch(/ascii\(substr\(entry_key, char_offset, 1\)\) BETWEEN 127 AND 159/i);
      expect(sql).toMatch(/ascii\(substr\(entry_key, char_offset, 1\)\) BETWEEN 8234 AND 8239/i);
      expect(sql).toMatch(/ascii\(substr\(entry_key, char_offset, 1\)\) BETWEEN 8294 AND 8297/i);
    });

    it("値は 1..3 要素の配列に制限する（最大3段階）", () => {
      expect(sql).toMatch(/IF jsonb_typeof\(entry_value\) <> 'array' THEN\s*\n\s*RETURN FALSE;/i);
      expect(sql).toMatch(/IF threshold_count < 1 OR threshold_count > 3 THEN/i);
    });

    it("しきい値は 2..9999 の整数に制限する（所有枚数1は被りではない）", () => {
      expect(sql).toMatch(/IF threshold_text !~ '\^\[0-9\]\+\$' THEN/i);
      expect(sql).toMatch(/IF current_threshold < 2 OR current_threshold > 9999 THEN/i);
    });

    it("しきい値の厳密増加を必須にする", () => {
      expect(sql).toMatch(
        /IF previous_threshold IS NOT NULL AND current_threshold <= previous_threshold THEN\s*\n\s*RETURN FALSE;/i
      );
    });

    it("CHECK 制約は drop してから張り直す（冪細）", () => {
      expect(sql).toMatch(
        /DROP CONSTRAINT IF EXISTS streamers_duplicate_display_tiers_valid/i
      );
      expect(sql).toMatch(
        /ADD CONSTRAINT streamers_duplicate_display_tiers_valid\s*\n\s*CHECK \(public\.check_duplicate_display_tiers_values\(duplicate_display_tiers\)\)/i
      );
    });
  });

  describe("(b) rename_card_pack を変更しない", () => {
    it("キーはレアリティ名なのでパック名変更のカスケードは不要", () => {
      // パック名カスケードを不用意に増やすと rename RPC が太り、レビュー範囲も
      // 広がる。キーがレアリティ名である以上、カスケード追加は YAGNI。
      expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.rename_card_pack/i);
    });
  });

  describe("(c) 適用範囲", () => {
    it("transaction 必須・planetscale のみ対象として宣言する", () => {
      expect(sql).toMatch(/-- migration-transaction: required/i);
      expect(sql).toMatch(/-- migration-providers: planetscale/i);
    });
  });
});
