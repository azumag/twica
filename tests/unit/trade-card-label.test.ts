import { describe, expect, it } from "vitest";
import { formatTradeCardLabel } from "@/lib/trade-card-label";
import jaMessages from "../../messages/ja.json";
import enMessages from "../../messages/en.json";

/**
 * トレード・オークション画面のカード表示名（#2070 フォローアップ / C4a）。
 *
 * C3a/C3b の DTO は「名前が非公開なら name: ""」「表示番号は閲覧者非依存の
 * collectionNumber」「カード定義が削除済みなら collectionNumber: null」を返す。
 * 画面が空白表示にならないための優先順位（名前 → #N → 削除されたカード）を
 * ここで固定する。
 */
const ja = jaMessages.trade;
const en = enMessages.trade;

const JA_TEMPLATES = {
  cardNumberTemplate: ja.cardNumberLabel,
  deletedLabel: ja.deletedCardName,
};

describe("formatTradeCardLabel (#2070 follow-up)", () => {
  it("uses the real name whenever it is visible", () => {
    expect(formatTradeCardLabel({ name: "Blue Dragon", collectionNumber: 12 }, JA_TEMPLATES)).toBe(
      "Blue Dragon",
    );
    // 名前があれば番号より優先する（コレクション画面と同じカード名表示）。
    expect(formatTradeCardLabel({ name: "Blue Dragon", collectionNumber: null }, JA_TEMPLATES)).toBe(
      "Blue Dragon",
    );
  });

  it("falls back to the display number (#N) when the name is hidden", () => {
    expect(formatTradeCardLabel({ name: "", collectionNumber: 12 }, JA_TEMPLATES)).toBe("#12");
  });

  it("treats a whitespace-only name as hidden", () => {
    expect(formatTradeCardLabel({ name: "   ", collectionNumber: 3 }, JA_TEMPLATES)).toBe("#3");
    expect(formatTradeCardLabel({ name: "   ", collectionNumber: null }, JA_TEMPLATES)).toBe(
      ja.deletedCardName,
    );
  });

  it("uses the deleted-card label when neither a name nor a number is known", () => {
    // card_id = NULL（削除済み定義）は C3a の maskTradeCards でこの形になる。
    expect(formatTradeCardLabel({ name: "", collectionNumber: null }, JA_TEMPLATES)).toBe(
      ja.deletedCardName,
    );
    // collectionNumber を持たない型（所持カードのグループなど）も同じ経路。
    expect(formatTradeCardLabel({ name: "" }, JA_TEMPLATES)).toBe(ja.deletedCardName);
  });

  it("never shows an unproven number (fail-closed)", () => {
    // createCollectionNumberMap は 1 以上しか作らない。壊れた 0 / 負値 / 小数を
    // #N として表示するとコレクション画面の番号と食い違うため削除表示へ倒す。
    expect(formatTradeCardLabel({ name: "", collectionNumber: 0 }, JA_TEMPLATES)).toBe(
      ja.deletedCardName,
    );
    expect(formatTradeCardLabel({ name: "", collectionNumber: -4 }, JA_TEMPLATES)).toBe(
      ja.deletedCardName,
    );
    expect(formatTradeCardLabel({ name: "", collectionNumber: 1.5 }, JA_TEMPLATES)).toBe(
      ja.deletedCardName,
    );
  });

  it("renders the English templates", () => {
    expect(
      formatTradeCardLabel(
        { name: "", collectionNumber: 7 },
        { cardNumberTemplate: en.cardNumberLabel, deletedLabel: en.deletedCardName },
      ),
    ).toBe("#7");
    expect(
      formatTradeCardLabel(
        { name: "", collectionNumber: null },
        { cardNumberTemplate: en.cardNumberLabel, deletedLabel: en.deletedCardName },
      ),
    ).toBe(en.deletedCardName);
  });

  it("keeps the #N template identical to the collection screen's (ja/en)", () => {
    // trade のクライアント provider は collection namespace を積まない
    // （src/i18n/client-namespaces.ts）ため trade 側に同じテンプレートを持つ。
    // 値がずれるとコレクション画面とトレード画面で番号表記が食い違うので、
    // ここで両ロケールの同値を固定する。
    expect(ja.cardNumberLabel).toBe(jaMessages.collection.cardNumber);
    expect(en.cardNumberLabel).toBe(enMessages.collection.cardNumber);
  });
});
