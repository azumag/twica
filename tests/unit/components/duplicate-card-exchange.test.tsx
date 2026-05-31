import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import DuplicateCardExchange from "@/components/DuplicateCardExchange";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const translations = {
  title: "ダブり交換",
  balance: "カードストーン: {count}",
  empty: "交換できるダブりカードはありません。",
  description: "説明",
  exchange: "砕く",
  exchanging: "交換中...",
  cardNumberTemplate: "No.{number}",
  duplicateCountTemplate: "ダブり {count}枚",
  stoneValueTemplate: "{count}ストーン",
  confirmTemplate:
    "「{name}」のダブり1枚を{count}カードストーンに交換します。よろしいですか？",
  successTemplate: "{count}カードストーンを獲得しました。",
  errorFallback: "ダブりカードの交換に失敗しました。",
};

const card = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "テストカード",
  rarity: "rare" as const,
  count: 3,
  collectionNumber: 7,
  stoneValue: 3,
};

describe("DuplicateCardExchange の交換確認", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    // crypto.randomUUID をスタブ化して requestId 生成を検証可能にする
    vi.stubGlobal("crypto", {
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("確認ダイアログでキャンセルすると交換APIを呼ばない", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <DuplicateCardExchange
        balance={10}
        cards={[card]}
        translations={translations}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "砕く" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      "「テストカード」のダブり1枚を3カードストーンに交換します。よろしいですか？"
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("確認ダイアログでOKすると requestId 付きで交換APIを呼ぶ", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ stonesGained: 3 }),
    });

    render(
      <DuplicateCardExchange
        balance={10}
        cards={[card]}
        translations={translations}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "砕く" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/card-stones/exchange",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            cardId: card.id,
            requestId: "22222222-2222-4222-8222-222222222222",
          }),
        })
      );
    });
  });
});
