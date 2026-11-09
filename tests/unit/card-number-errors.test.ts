import { describe, expect, it } from "vitest";
import { isCardNumberConflictError } from "@/lib/card-number-errors";

/**
 * Drizzle が postgres.js のエラーを1段ラップした DrizzleQueryError を模倣する
 * （`{ query, params, cause }`。SQLSTATE・実メッセージは cause 側にのみ存在する）。
 * insertCardPg (src/app/api/cards/route.ts) はこの形のエラーをそのまま
 * isCardNumberConflictError に渡す。
 *
 * #954: このファイルにあった isMissingCardNumberColumnError（cards.card_number
 * 列のデプロイ窓フォールバック判定）のテストは、判定関数の撤去（本番・preview
 * の information_schema.columns 実測で card_number が実在することを確認）に合わせて
 * 削除した。isCardNumberConflictError は unique 制約違反 (23505) の現役
 * エラーハンドリングであり、デプロイ窓フォールバックではないため残す。
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

// 2026-07 本番障害の回帰テスト: pg 直結の insertCardPg (cards/route.ts) は
// db.insert(...).returning() の catch を isCardNumberConflictError にそのまま渡す。
// Drizzle は postgres.js のエラーを `{ query, params, cause }` で1段ラップするため、
// トップレベルの code/message/details だけを見ていると pg 経路でこの判定が
// 機能しない（src/lib/db/errors.ts の getErrorChain が対応する、同種バグと
// 同じ原因）。
describe("Drizzle にラップされたエラー（cause チェーン）", () => {
  it("isCardNumberConflictError: ラップされた 23505 (unique constraint) を検知する", () => {
    const cause = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "cards_streamer_card_number_unique"',
    };
    expect(isCardNumberConflictError(wrapped(cause))).toBe(true);
  });

  it("該当しないラップされたエラーは false のまま", () => {
    const cause = { code: "42501", message: "permission denied for table cards" };
    expect(isCardNumberConflictError(wrapped(cause))).toBe(false);
  });

  // 2026-07 Fable厳格レビュー指摘(中4)の回帰テスト: 「全階層のテキストを連結
  // してから判定する」実装だと、ラッパー層（DrizzleQueryError.message = 実行
  // された SQL 文そのもの。INSERT 対象列に "card_number" を含む）に判定対象の
  // 語が偶然含まれているだけで、cause が全く無関係のエラーでも誤検知して
  // しまう。各階層は自分自身の code/message だけで独立に判定されるべき。
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
