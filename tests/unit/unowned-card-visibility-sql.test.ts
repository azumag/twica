import { describe, expect, it } from "vitest";

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { streamers } from "@/lib/db/schema";
import {
  resolveUnownedCardVisibility,
  unownedCardItemVisibleSql,
} from "@/lib/unowned-card-visibility";

/**
 * SQL 版の未所持カード項目別公開（unownedCardItemVisibleSql）が、
 * TypeScript の resolveUnownedCardVisibility と同じ規則（a〜d）を表現して
 * いることを SQL テキストで固定する。
 *
 * 実際の行解決（相関 EXISTS・NULL・is_active の組み合わせ）は
 * tests/integration/trade-visibility-pg.test.ts が実 PostgreSQL で検証する。
 * ここは「規則の分岐が SQL に存在すること」と「デプロイ窓で新3列を参照
 * しないこと」を高速に守るためのもの。
 */
/** 引用符は判定に不要なので落として、列名と式だけを比較する。 */
const render = (fragment: SQL) =>
  new PgDialect().sqlToQuery(drizzleSql`${fragment}`).sql.replace(/"/g, "");

const columns = {
  show_unowned_cards: streamers.show_unowned_cards,
  show_unowned_card_details: streamers.show_unowned_card_details,
  show_unowned_card_name: streamers.show_unowned_card_name,
  show_unowned_card_image: streamers.show_unowned_card_image,
  show_unowned_card_description: streamers.show_unowned_card_description,
};

describe("unownedCardItemVisibleSql: resolver との同値規則", () => {
  it.each(["name", "image", "description"] as const)(
    "rule a + d: %s はマスタースイッチと対象列の AND",
    (item) => {
      const sql = render(unownedCardItemVisibleSql(columns, item));
      expect(sql).toContain("streamers.show_unowned_cards = TRUE");
      expect(sql).toContain(`streamers.show_unowned_card_${item} = TRUE`);
    },
  );

  it("rule c: details=false かつ新3列すべて true のときだけ全非公開へ倒す", () => {
    const sql = render(unownedCardItemVisibleSql(columns, "name"));
    // ガードは「3列すべて TRUE」に限定する（部分公開は正当な状態）。
    expect(sql).toMatch(
      /NOT \(\s*streamers\.show_unowned_card_details = FALSE\s+AND streamers\.show_unowned_card_name = TRUE\s+AND streamers\.show_unowned_card_image = TRUE\s+AND streamers\.show_unowned_card_description = TRUE\s*\)/,
    );
  });

  it("rule b: 新3列が欠落するデプロイ窓では旧 details だけを参照する", () => {
    const sql = render(
      unownedCardItemVisibleSql(columns, "image", { withoutItemColumns: true }),
    );
    expect(sql).toContain("streamers.show_unowned_cards = TRUE");
    expect(sql).toContain("streamers.show_unowned_card_details = TRUE");
    expect(sql).not.toContain("show_unowned_card_name");
    expect(sql).not.toContain("show_unowned_card_image");
    expect(sql).not.toContain("show_unowned_card_description");
  });

  it("項目ごとに参照する列が異なる（名前と画像の独立公開）", () => {
    const nameSql = render(unownedCardItemVisibleSql(columns, "name"));
    const imageSql = render(unownedCardItemVisibleSql(columns, "image"));
    // ガード c が3列すべてを参照するため、単純な有無では区別できない。
    // 対象項目の列だけが「項目判定 + ガード c」の2回現れることを固定する。
    const occurrences = (text: string, needle: string) =>
      text.split(needle).length - 1;
    expect(occurrences(nameSql, "streamers.show_unowned_card_name = TRUE")).toBe(2);
    expect(occurrences(nameSql, "streamers.show_unowned_card_image = TRUE")).toBe(1);
    expect(occurrences(imageSql, "streamers.show_unowned_card_image = TRUE")).toBe(2);
    expect(occurrences(imageSql, "streamers.show_unowned_card_name = TRUE")).toBe(1);
  });
});

describe("resolveUnownedCardVisibility: SQL と対応する TS 規則", () => {
  const resolved = (
    overrides: Partial<Parameters<typeof resolveUnownedCardVisibility>[0]>,
  ) => resolveUnownedCardVisibility({
    show_unowned_cards: true,
    show_unowned_card_details: false,
    show_unowned_card_name: false,
    show_unowned_card_image: false,
    show_unowned_card_description: false,
    ...overrides,
  });

  it("name-only / image-only は独立に解決する", () => {
    expect(resolved({ show_unowned_card_name: true })).toEqual({
      name: true,
      image: false,
      description: false,
    });
    expect(resolved({ show_unowned_card_image: true })).toEqual({
      name: false,
      image: true,
      description: false,
    });
  });

  it("ガード c とマスタースイッチ a は SQL と同じ方向へ倒れる", () => {
    expect(resolved({
      show_unowned_card_name: true,
      show_unowned_card_image: true,
      show_unowned_card_description: true,
    })).toEqual({ name: false, image: false, description: false });
    expect(resolved({
      show_unowned_cards: false,
      show_unowned_card_name: true,
      show_unowned_card_image: true,
      show_unowned_card_description: true,
    })).toEqual({ name: false, image: false, description: false });
  });
});
