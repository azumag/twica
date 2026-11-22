// Real-PostgreSQL contract test for the legacy mirror UPDATE of the streamer
// settings API (#2070 follow-up).
//
// 背景:
// POST /api/streamer/settings は、未所持カードの項目別設定（名前・画像・説明）を
// 保存するとき、旧列 show_unowned_card_details を「同一 UPDATE の SET 右辺で、
// 送信値と現在列の COALESCE を AND した SQL 式」としてミラー書込みする
// （unownedCardDetailsMirrorSql）。unit テスト（tests/unit/streamer-settings-api.test.ts）
// は Drizzle をモックしており「描画された SQL の構造」しか検証できない。次の点は
// 実際に UPDATE を実行しないと分からず、これが実行時に落ちると設定保存が全員 500 になる:
//   - SET 右辺で更新前の行値（列参照）を使えること
//   - `$n::boolean` のパラメータ型推論（null を含む）が通ること
//   - 部分更新で未送信項目が「現在値」へフォールバックすること
//   - NOT NULL 列（show_unowned_card_details）へ代入できること
// このスイートは route.ts と同じ組み立て（個別列 + ミラー式）の UPDATE を実 DB で
// 実行し、実列を SELECT して確認する。
//
// 専用の使い捨て PostgreSQL のみで実行する（trade-visibility-pg.test.ts と同じ方針）。
// 共有 DB を STREAMER_SETTINGS_TEST_DATABASE_URL に指定してはならない。変数が無ければ
// スイート全体をスキップする。
//
// Local run (example):
//   apply db/planetscale baseline + grants + migrations (see ci.yml
//   "Apply PlanetScale baseline and additive migrations"), then
//   STREAMER_SETTINGS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
//     npx vitest run tests/integration/streamer-settings-mirror-pg.test.ts
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { streamers as streamersTable } from "@/lib/db/schema";
import { unownedCardDetailsMirrorSql } from "@/lib/unowned-card-visibility";

const url = process.env.STREAMER_SETTINGS_TEST_DATABASE_URL;

const sql = url ? postgres(url, { max: 2, onnotice: () => {} }) : null;
const db = sql ? drizzle(sql, { schema }) : null;

// Deterministic id (prefix 5e77… is reserved for this suite and cleaned up).
const SID = "5e770000-0000-4000-8000-000000000001";

interface Flags {
  name: boolean;
  image: boolean;
  description: boolean;
  details: boolean;
}

interface Input {
  name?: boolean;
  image?: boolean;
  description?: boolean;
}

async function cleanup() {
  if (!sql) return;
  await sql`DELETE FROM streamers WHERE id = ${SID}`;
}

/** 行の項目別設定と旧 details を任意の値へ戻す（各ケースの前提状態）。 */
async function setRow(flags: Flags) {
  await sql!`
    UPDATE streamers SET
      show_unowned_card_name = ${flags.name},
      show_unowned_card_image = ${flags.image},
      show_unowned_card_description = ${flags.description},
      show_unowned_card_details = ${flags.details}
    WHERE id = ${SID}`;
}

/** 実列を読む。assert は必ずこの値に対して行う。 */
async function readRow(): Promise<Flags> {
  const rows = await sql!`
    SELECT show_unowned_card_name AS name, show_unowned_card_image AS image,
           show_unowned_card_description AS description,
           show_unowned_card_details AS details
    FROM streamers WHERE id = ${SID}`;
  expect(rows).toHaveLength(1);
  return rows[0] as unknown as Flags;
}

/**
 * route.ts の項目別分岐と同じ形の UPDATE を実行する。
 * 送信された項目だけ個別列へ保存し、details にはミラー式を渡す。
 */
async function applyItemUpdate(input: Input) {
  const set: Partial<typeof streamersTable.$inferInsert> = {};
  if (input.name !== undefined) set.show_unowned_card_name = input.name;
  if (input.image !== undefined) set.show_unowned_card_image = input.image;
  if (input.description !== undefined) set.show_unowned_card_description = input.description;
  await db!
    .update(streamersTable)
    .set({
      ...set,
      show_unowned_card_details: unownedCardDetailsMirrorSql(input, streamersTable),
    })
    .where(eq(streamersTable.id, SID));
}

describe.skipIf(!sql)("streamer settings legacy mirror UPDATE on actual PostgreSQL", () => {
  beforeAll(async () => {
    await cleanup();
    // NOT NULL 列の埋め方は trade-visibility-pg.test.ts の streamer() ヘルパと同じ
    // （最小の必須列だけを指定し、残りは DB の DEFAULT に任せる）。
    await sql!`
      INSERT INTO streamers (
        id, twitch_user_id, twitch_username, twitch_display_name,
        show_unowned_cards, show_unowned_card_details, show_unowned_card_name,
        show_unowned_card_image, show_unowned_card_description
      ) VALUES (
        ${SID}, 'settings-mirror-streamer', 'settings-mirror-streamer',
        'Settings Mirror Streamer', TRUE, FALSE, FALSE, FALSE, FALSE
      )`;
  });
  afterAll(async () => {
    await cleanup();
    await sql?.end();
  });
  beforeEach(async () => {
    // 前のケースの結果を引きずらない。
    await setRow({ name: false, image: false, description: false, details: false });
  });

  describe("all three items sent", () => {
    it("(a) sending all three true stores true in every column and details", async () => {
      await applyItemUpdate({ name: true, image: true, description: true });
      expect(await readRow()).toEqual({ name: true, image: true, description: true, details: true });
    });

    it("sending all three false stores false in every column and details", async () => {
      await setRow({ name: true, image: true, description: true, details: true });
      await applyItemUpdate({ name: false, image: false, description: false });
      expect(await readRow()).toEqual({ name: false, image: false, description: false, details: false });
    });

    it.each([
      ["name", { name: false, image: true, description: true }],
      ["image", { name: true, image: false, description: true }],
      ["description", { name: true, image: true, description: false }],
    ] as const)("(b) one item false (%s) makes details false while the other items keep true", async (_label, input) => {
      await setRow({ name: true, image: true, description: true, details: true });
      await applyItemUpdate(input);
      expect(await readRow()).toEqual({ ...input, details: false });
    });
  });

  describe("(c) partial update falls back to the current row values", () => {
    it("name=true with current image=true/description=true makes details true", async () => {
      await setRow({ name: false, image: true, description: true, details: false });
      await applyItemUpdate({ name: true });
      expect(await readRow()).toEqual({ name: true, image: true, description: true, details: true });
    });

    it("name=true with current image=false keeps image false and makes details false", async () => {
      await setRow({ name: false, image: false, description: true, details: false });
      await applyItemUpdate({ name: true });
      expect(await readRow()).toEqual({ name: true, image: false, description: true, details: false });
    });

    it("image=true only: unsent name/description come from the current row", async () => {
      await setRow({ name: true, image: false, description: true, details: false });
      await applyItemUpdate({ image: true });
      expect(await readRow()).toEqual({ name: true, image: true, description: true, details: true });
    });

    it("description=true with current name=false makes details false", async () => {
      await setRow({ name: false, image: true, description: false, details: false });
      await applyItemUpdate({ description: true });
      expect(await readRow()).toEqual({ name: false, image: true, description: true, details: false });
    });

    it("name=false with every other item currently true makes details false", async () => {
      await setRow({ name: true, image: true, description: true, details: true });
      await applyItemUpdate({ name: false });
      expect(await readRow()).toEqual({ name: false, image: true, description: true, details: false });
    });

    it("recomputes a stale details value from the current columns, not from the old details", async () => {
      // details=true だが image=false という食い違い行（旧アプリ経由などで起こり得る）。
      // ミラーは旧 details ではなく現在の3列から計算し直す。
      await setRow({ name: true, image: false, description: true, details: true });
      await applyItemUpdate({ name: true });
      expect(await readRow()).toEqual({ name: true, image: false, description: true, details: false });
    });
  });

  describe("(d) nothing sent (all undefined)", () => {
    it("executes and stores the AND of the current columns: all true -> true", async () => {
      await setRow({ name: true, image: true, description: true, details: false });
      await applyItemUpdate({});
      expect(await readRow()).toEqual({ name: true, image: true, description: true, details: true });
    });

    it("executes and stores the AND of the current columns: partially true -> false", async () => {
      await setRow({ name: true, image: true, description: false, details: true });
      await applyItemUpdate({});
      expect(await readRow()).toEqual({ name: true, image: true, description: false, details: false });
    });
  });

  describe("legacy client (showUnownedCardDetails only)", () => {
    // route.ts の旧クライアント分岐: 3項目と details へ同じ値を直接書く（ミラー式は使わない）。
    const applyLegacyUpdate = async (value: boolean) => {
      await db!
        .update(streamersTable)
        .set({
          show_unowned_card_details: value,
          show_unowned_card_name: value,
          show_unowned_card_image: value,
          show_unowned_card_description: value,
        })
        .where(eq(streamersTable.id, SID));
    };

    it("true expands to the three items and details", async () => {
      await applyLegacyUpdate(true);
      expect(await readRow()).toEqual({ name: true, image: true, description: true, details: true });
    });

    it("false expands to the three items and details", async () => {
      await setRow({ name: true, image: true, description: true, details: true });
      await applyLegacyUpdate(false);
      expect(await readRow()).toEqual({ name: false, image: false, description: false, details: false });
    });
  });
});
