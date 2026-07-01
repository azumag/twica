import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Issue #393再設計: 事前登録カードパック名一覧マイグレーションは
// custom_rarities(00049)と同じパターンを踏襲する: JSONB配列・空配列
// デフォルト・型/件数のCHECK制約・冪等なDROP→ADD CONSTRAINT。
describe("card pack names migration (00062)", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../supabase/migrations/00062_add_streamer_card_pack_names.sql"),
    "utf8"
  );

  it("adds card_pack_names as a JSONB column with an empty-array default", () => {
    expect(sql).toMatch(
      /alter table streamers\s+add column if not exists card_pack_names jsonb not null default '\[\]'::jsonb/i
    );
  });

  it("idempotently re-applies the CHECK constraint (drop before add)", () => {
    expect(sql).toMatch(/drop constraint if exists streamers_card_pack_names_valid/i);
    expect(sql).toMatch(/add constraint streamers_card_pack_names_valid check/i);
  });

  it("enforces array type and a 50-entry cap", () => {
    expect(sql).toMatch(/jsonb_typeof\(card_pack_names\)\s*=\s*'array'/i);
    expect(sql).toMatch(/jsonb_array_length\(card_pack_names\)\s*<=\s*50/i);
  });

  it("does not introduce permissive public RLS policies", () => {
    expect(sql).not.toMatch(/FOR ALL\s+USING\s*\(true\)/i);
    expect(sql).not.toMatch(/TO\s+authenticated/i);
  });
});
