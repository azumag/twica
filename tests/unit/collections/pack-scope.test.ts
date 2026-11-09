import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { cards as cardsTable } from "@/lib/db/schema";
import { buildPackScopePredicate } from "@/lib/collections/pack-scope";
import { DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";

// Issue #1994: 抽選プールのパック絞り込み条件。SQL 文字列へ実際にレンダリングして
// 検証する（モック DB では条件の取り違えを検出できないため）。
const dialect = new PgDialect();
const render = (predicate: SQL | undefined) => {
  if (!predicate) return undefined;
  const { sql, params } = dialect.sqlToQuery(predicate);
  return { sql, params };
};

describe("buildPackScopePredicate", () => {
  it("returns undefined for an empty selection (= all cards, no WHERE on collection_name)", () => {
    expect(buildPackScopePredicate(cardsTable.collection_name, [])).toBeUndefined();
  });

  it("keeps the single-pack predicate byte-identical to the legacy eq()", () => {
    expect(render(buildPackScopePredicate(cardsTable.collection_name, ["weapons"]))).toEqual({
      sql: '"cards"."collection_name" = $1',
      params: ["weapons"],
    });
  });

  it("keeps the default-pack-only predicate as IS NULL", () => {
    expect(render(buildPackScopePredicate(cardsTable.collection_name, [DEFAULT_PACK_SENTINEL]))).toEqual({
      sql: '"cards"."collection_name" is null',
      params: [],
    });
  });

  it("uses IN for 2+ named packs", () => {
    expect(render(buildPackScopePredicate(cardsTable.collection_name, ["weapons", "characters"]))).toEqual({
      sql: '"cards"."collection_name" in ($1, $2)',
      params: ["weapons", "characters"],
    });
  });

  // `__default__` を IN に入れると「パック名が文字列 __default__ のカード」を探す
  // 誤った条件になる（未分類カードは collection_name IS NULL）。
  it("expands __default__ to OR IS NULL instead of putting the sentinel inside IN", () => {
    const query = render(
      buildPackScopePredicate(cardsTable.collection_name, ["weapons", DEFAULT_PACK_SENTINEL, "characters"])
    );
    expect(query).toEqual({
      sql: '("cards"."collection_name" in ($1, $2) or "cards"."collection_name" is null)',
      params: ["weapons", "characters"],
    });
    expect(query?.params).not.toContain(DEFAULT_PACK_SENTINEL);
  });

  it("uses eq OR IS NULL for one named pack plus the default pack", () => {
    expect(
      render(buildPackScopePredicate(cardsTable.collection_name, [DEFAULT_PACK_SENTINEL, "weapons"]))
    ).toEqual({
      sql: '("cards"."collection_name" = $1 or "cards"."collection_name" is null)',
      params: ["weapons"],
    });
  });
});
