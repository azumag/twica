/**
 * card-padding-color-errors.ts（旧 cards-safe-columns.ts、#834 で改名）の単体テスト。
 *
 * #834 で「本番未デプロイ8列」フォールバック（CARDS_SAFE_COLUMNS /
 * withCardsBattleColumnFallback / isMissingCardsBattleColumnError）を撤去した後、
 * 残る責務は image_padding_color（#899）専用の isMissingCardPaddingColorError と
 * CARDS_COLUMNS_WITHOUT_PADDING_COLOR のみ。
 *
 * 各ルートの driver-parity テストにあった
 * `expect(returningFields).toEqual(CARDS_COLUMNS_WITHOUT_PADDING_COLOR)` は
 * 定数を定数と比較する自己参照的なアサーションで、分割代入のキー名を
 * 間違えても検出できない。ここでは実際の列集合の中身（image_padding_color を
 * 含まない・他の実列は含む）を直接検証する。
 */
import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  isMissingCardPaddingColorError,
  CARDS_COLUMNS_WITHOUT_PADDING_COLOR,
} from "@/lib/db/card-padding-color-errors";
import { cards as cardsTable } from "@/lib/db/schema";

describe("isMissingCardPaddingColorError", () => {
  it("image_padding_color 列欠落エラー(42703)を検知する", () => {
    const error = Object.assign(
      new Error('column "image_padding_color" of relation "cards" does not exist'),
      { code: "42703" },
    );
    expect(isMissingCardPaddingColorError(error)).toBe(true);
  });

  it("Drizzle にラップされたエラー(cause側)からも検知する", () => {
    const cause = Object.assign(
      new Error('column "image_padding_color" of relation "cards" does not exist'),
      { code: "42703" },
    );
    const wrapped = Object.assign(new Error("Failed query: ..."), { cause });
    expect(isMissingCardPaddingColorError(wrapped)).toBe(true);
  });

  it("image_padding_color 以外の列欠落エラーは false", () => {
    const error = Object.assign(
      new Error('column "hp" of relation "cards" does not exist'),
      { code: "42703" },
    );
    expect(isMissingCardPaddingColorError(error)).toBe(false);
  });

  it("列欠落以外のエラー(42501等)は false", () => {
    const error = Object.assign(new Error("permission denied"), { code: "42501" });
    expect(isMissingCardPaddingColorError(error)).toBe(false);
  });
});

describe("CARDS_COLUMNS_WITHOUT_PADDING_COLOR", () => {
  it("image_padding_color を含まない", () => {
    expect(Object.keys(CARDS_COLUMNS_WITHOUT_PADDING_COLOR)).not.toContain("image_padding_color");
  });

  it("image_padding_color 以外の cards の実列はすべて含む(id・card_number・hp等を含め、余分な絞り込みをしていないことの確認)", () => {
    const keys = Object.keys(CARDS_COLUMNS_WITHOUT_PADDING_COLOR);
    expect(keys).toEqual(
      expect.arrayContaining([
        "id",
        "streamer_id",
        "name",
        "description",
        "image_url",
        "rarity",
        "rarity_order",
        "drop_rate",
        "intra_rarity_weight",
        "card_number",
        "max_issuance_count",
        "collection_name",
        "is_active",
        "hp",
        "atk",
        "def",
        "spd",
        "skill_type",
        "skill_name",
        "skill_power",
        "created_at",
        "updated_at",
      ]),
    );
    // image_padding_color の1列だけを除いた集合であることを列数でも確認する。
    // 固定値ではなく cards の実列数から動的に算出し、将来 cards に列が
    // 増減しても「1列だけ除外」という意図そのものは壊れずに検証できるようにする。
    expect(keys).toHaveLength(Object.keys(getTableColumns(cardsTable)).length - 1);
  });
});
