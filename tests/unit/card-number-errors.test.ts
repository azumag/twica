import { describe, expect, it } from "vitest";
import { isCardNumberConflictError, isMissingCardNumberColumnError } from "@/lib/card-number-errors";

/**
 * Drizzle が postgres.js のエラーを1段ラップした DrizzleQueryError を模倣する
 * （`{ query, params, cause }`。SQLSTATE・実メッセージは cause 側にのみ存在する）。
 * insertCardPg (src/app/api/cards/route.ts) はこの形のエラーをそのまま
 * isMissingCardNumberColumnError / isCardNumberConflictError に渡す。
 */
function wrapped(cause: unknown) {
  return { query: "insert into cards (...) returning *", params: [], cause };
}

describe("card-number-errors", () => {
  it("detects card number unique constraint violations", () => {
    expect(isCardNumberConflictError({
      code: "23505",
      message: "duplicate key value violates unique constraint \"cards_streamer_card_number_unique\"",
    })).toBe(true);
  });

  it("ignores unrelated database errors", () => {
    expect(isCardNumberConflictError({
      code: "23505",
      message: "duplicate key value violates unique constraint \"other_constraint\"",
    })).toBe(false);
    expect(isCardNumberConflictError({ code: "42P01", message: "relation missing" })).toBe(false);
  });
});

describe("isMissingCardNumberColumnError", () => {
  it("detects PostgREST schema-cache errors for cards.card_number", () => {
    expect(isMissingCardNumberColumnError({
      code: "PGRST204",
      message: "Could not find the 'card_number' column of 'cards' in the schema cache",
    })).toBe(true);
  });

  it("ignores unrelated missing-column errors", () => {
    expect(isMissingCardNumberColumnError({
      code: "PGRST204",
      message: "Could not find the 'other_column' column of 'cards' in the schema cache",
    })).toBe(false);
  });
});

// 2026-07 本番障害の回帰テスト: pg 直結の insertCardPg (cards/route.ts) は
// db.insert(...).returning() の catch を isMissingCardNumberColumnError /
// isCardNumberConflictError にそのまま渡す。Drizzle は postgres.js のエラーを
// `{ query, params, cause }` で1段ラップするため、トップレベルの
// code/message/details だけを見ていると pg 経路でこのフォールバックが
// 機能しない（cards-safe-columns.ts の同種バグと同じ原因）。
describe("Drizzle にラップされたエラー（cause チェーン）", () => {
  it("isMissingCardNumberColumnError: ラップされた 42703 (does not exist 文言) を検知する", () => {
    const cause = { code: "42703", message: 'column "card_number" of relation "cards" does not exist' };
    expect(isMissingCardNumberColumnError(wrapped(cause))).toBe(true);
  });

  it("isMissingCardNumberColumnError: ラップされた PGRST204 も検知する", () => {
    const cause = {
      code: "PGRST204",
      message: "Could not find the 'card_number' column of 'cards' in the schema cache",
    };
    expect(isMissingCardNumberColumnError(wrapped(cause))).toBe(true);
  });

  it("isCardNumberConflictError: ラップされた 23505 (unique constraint) を検知する", () => {
    const cause = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "cards_streamer_card_number_unique"',
    };
    expect(isCardNumberConflictError(wrapped(cause))).toBe(true);
  });

  it("多重ラップ（cause.cause）でも検知できる", () => {
    const cause = { code: "42703", message: 'column "card_number" of relation "cards" does not exist' };
    expect(isMissingCardNumberColumnError(wrapped(wrapped(cause)))).toBe(true);
  });

  it("該当しないラップされたエラーは false のまま", () => {
    const cause = { code: "42501", message: "permission denied for table cards" };
    expect(isMissingCardNumberColumnError(wrapped(cause))).toBe(false);
    expect(isCardNumberConflictError(wrapped(cause))).toBe(false);
  });

  // 2026-07 Fable厳格レビュー指摘(中4)の回帰テスト: 「全階層のテキストを連結
  // してから判定する」実装だと、ラッパー層（DrizzleQueryError.message = 実行
  // された SQL 文そのもの。INSERT 対象列に "card_number" を含む）に判定対象の
  // 語が偶然含まれているだけで、cause が全く無関係のエラーでも誤検知して
  // しまう。各階層は自分自身の code/message だけで独立に判定されるべき。
  it("ラッパーのINSERT文にcard_numberが含まれても、causeが無関係なエラーならfalse", () => {
    const wrapperWithColumnInSql = {
      message: 'Failed query: insert into "cards" ("id", "card_number", "name") values (...)',
      query: 'insert into "cards" ("id", "card_number", "name") values (...)',
      params: [],
      cause: { code: "CONNECTION_CLOSED", message: "connection closed" },
    };
    expect(isMissingCardNumberColumnError(wrapperWithColumnInSql)).toBe(false);
  });

  it("ラッパーのINSERT文にcard_numberが含まれても、causeが別の一意制約違反ならfalse", () => {
    const wrapperWithColumnInSql = {
      message: 'Failed query: insert into "cards" ("id", "card_number", "name") values (...)',
      query: 'insert into "cards" ("id", "card_number", "name") values (...)',
      params: [],
      cause: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "cards_pkey"',
      },
    };
    expect(isCardNumberConflictError(wrapperWithColumnInSql)).toBe(false);
  });
});
