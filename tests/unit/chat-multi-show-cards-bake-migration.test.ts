import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #1548: chat_announcement_multi_show_cards 廃止に向けた互換移行 migration の
// 静的契約テスト。実DBの bake 結果の等価性は
// chat-multi-show-cards-compat.test.ts が JS ミラーで固定し、ここでは
// SQL 本体がそのミラーと同じ規則を持つ構造を検証する。
const migration = readFileSync(
  resolve(
    process.cwd(),
    "db/planetscale/migrations/20261030120000_chat_multi_show_cards_bake.sql",
  ),
  "utf8",
);
// コメントを除いた実行部だけを対象にする（コメント中の記述を誤検出しない）。
const codeOnly = migration
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("chat multi_show_cards bake migration (Issue #1548)", () => {
  it("PlanetScale transaction migration として宣言する", () => {
    expect(migration).toMatch(
      /^-- migration-transaction: required\n-- migration-providers: planetscale/,
    );
  });

  it("フラグ列を一切更新しない（OFF行の旧暗黙追記の再発火を防ぐ）", () => {
    // flag を一括 true 化すると、OFF + placeholder無しカスタム行が
    // 旧エンジン稼働中に「（全N枚）」追記を再開し実効出力が変わる。
    // bake はテンプレート列だけを更新し、フラグ列には触れない。
    const setTargets = [...codeOnly.matchAll(/SET\s+(\w+)/g)].map((m) => m[1]);
    expect(setTargets).toEqual([
      "chat_announcement_multi_template",
      "chat_announcement_multi_template",
    ]);
    // 列への代入が WHERE 等の他句の登場を誤検出しないよう、SET 直後の列名だけを見る。
    expect(setTargets).not.toContain("chat_announcement_multi_show_cards");
  });

  it("CASE1: flag OFF 行だけが対象で、カラム NOT NULL / 空文字を DEFAULT 焼き込みへ寄せる", () => {
    expect(codeOnly).toContain("chat_announcement_multi_show_cards = false");
    expect(codeOnly).toContain("chat_announcement_multi_template IS NULL");
    expect(codeOnly).toContain("chat_announcement_multi_template = ''");
    // DEFAULT から {cards} を除いた焼き込みリテラル
    expect(codeOnly).toContain(
      "@{user} が{draws}連ガチャで {rarityCounts} を獲得しました！",
    );
  });

  it("CASE1: カスタムテンプレートからカード名系 placeholder 4種だけを除去する", () => {
    // {draws} / {rarityCounts} はフラグ非依存のため除去対象に含めてはならない。
    for (const ph of ["{cards}", "{newCardsOrNone}", "{newCardCount}", "{newCards}"]) {
      expect(codeOnly).toContain(`'${ph}', ''`);
    }
    expect(codeOnly).not.toContain("'{draws}', ''");
    expect(codeOnly).not.toContain("'{rarityCounts}', ''");
  });

  it("CASE1: 除去後が空白のみになるテンプレートは `||` フォールバックを避けるため半角空白を書く", () => {
    expect(codeOnly).toMatch(/btrim\(REPLACE\(/);
    expect(codeOnly).toMatch(/= ''\s*\n?\s*THEN ' '/);
  });

  it("CASE2: flag ON + placeholder 非含有カスタムへ等価の「（全{draws}枚: {cards}）」を追記する", () => {
    expect(codeOnly).toContain(
      "|| '（全{draws}枚: {cards}）'",
    );
    // multi-draw placeholder 6種すべてを非含有条件に含める（エンジン側の集合と一致）。
    for (const ph of [
      "{cards}",
      "{draws}",
      "{rarityCounts}",
      "{newCards}",
      "{newCardCount}",
      "{newCardsOrNone}",
    ]) {
      expect(codeOnly).toContain(`NOT LIKE '%${ph}%'`);
    }
    // DEFAULT 扱いの空文字は追記対象外（`||` フォールバックと同じ扱い）。
    expect(codeOnly).toContain("chat_announcement_multi_template <> ''");
  });

  it("CASE2: flag OFF 行には追記しない（WHERE でフラグ分岐）", () => {
    const case2 = codeOnly.slice(codeOnly.lastIndexOf("UPDATE public.streamers"));
    expect(case2).toContain("chat_announcement_multi_show_cards = true");
  });

  it("冪等: 再実行しても対象行が変化しない条件を持つ", () => {
    // CASE1 は flag=false 行にのみ適用（焼き込み後も flag は変わらないが、
    // テンプレートが非NULL化・placeholder除去済みのため再適用は無害冪等。
    // ただし冪等性の正本は「焼き込みが同じ値に収束する」ことであり、
    // compat テスト側で bake の再適用不変性を固定している。
    expect(codeOnly).toContain("WHERE chat_announcement_multi_show_cards = false");
    // CASE2 は追記後に {draws}/{cards} を含むため NOT LIKE 群で自然に除外される。
  });

  it("破壊的操作を含まない（行削除・列削除・型変更なし）", () => {
    expect(codeOnly).not.toMatch(/DROP|DELETE FROM|ALTER COLUMN|TRUNCATE/i);
    // UPDATE は streamers テーブルのテンプレート列のみ
    const updates = codeOnly.match(/UPDATE public\.(\w+)/g) ?? [];
    expect(updates.every((u) => u === "UPDATE public.streamers")).toBe(true);
    expect(updates).toHaveLength(2);
  });
});
