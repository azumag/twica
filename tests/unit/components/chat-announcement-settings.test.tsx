import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatAnnouncementSettings from "@/components/ChatAnnouncementSettings";
import jaMessages from "../../../messages/ja.json";

// next-intl unescapes the ICU '{'...'}' sequences from messages/ja.json into literal
// {newCards}/{newCardCount} at render time, so the expectation here is the rendered
// text rather than the raw JSON string.
const NEW_CARD_WARNING_TEXT =
  "「N連通知にカード名一覧を含める」が無効なため、テンプレート内の {newCards} / {newCardCount} は送信時に空文字に置き換わります。内容を表示したい場合は上のチェックボックスを有効にしてください。";

function renderSettings(
  overrides: Partial<{
    currentMultiTemplate: string | null;
    currentMultiShowCards: boolean;
  }> = {}
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <ChatAnnouncementSettings
        streamerId="streamer-1"
        currentEnabled={false}
        currentTemplate={null}
        currentMultiTemplate={overrides.currentMultiTemplate ?? null}
        currentMultiShowCards={overrides.currentMultiShowCards ?? true}
        botAccount={null}
      />
    </NextIntlClientProvider>
  );
}

describe("ChatAnnouncementSettings", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ hasScope: true }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows template controls by default without the legacy advanced checkbox", async () => {
    renderSettings();

    expect(screen.queryByText("詳細設定を表示する")).not.toBeInTheDocument();
    expect(await screen.findByText("カスタムテンプレート（任意）")).toBeInTheDocument();
    expect(screen.getByText("N連ガチャ用テンプレート（任意）")).toBeInTheDocument();
    expect(screen.getByText("N連通知にカード名一覧を含める")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "チャットデモ" })).toBeInTheDocument();
  });

  // Issue #504: {newCards}/{newCardCount} is silently replaced with an empty string
  // when multi_show_cards is off, which looks like a misconfiguration. The UI must
  // surface a warning whenever the template references those placeholders while the
  // "show card names" toggle is disabled, and stay quiet otherwise.
  describe("newCards/newCardCount placeholder warning (#504)", () => {
    it("is hidden when multiShowCards is enabled even if the template uses {newCards}", async () => {
      renderSettings({
        currentMultiTemplate: "@{user} が新規カード {newCards} を獲得！",
        currentMultiShowCards: true,
      });

      await screen.findByText("N連ガチャ用テンプレート（任意）");
      expect(screen.queryByText(NEW_CARD_WARNING_TEXT)).not.toBeInTheDocument();
    });

    it("is hidden when multiShowCards is disabled but the template does not reference the placeholders", async () => {
      renderSettings({
        currentMultiTemplate: "@{user} が{draws}連ガチャを引きました！",
        currentMultiShowCards: false,
      });

      await screen.findByText("N連ガチャ用テンプレート（任意）");
      expect(screen.queryByText(NEW_CARD_WARNING_TEXT)).not.toBeInTheDocument();
    });

    it("is shown when multiShowCards is disabled and the template uses {newCards}", async () => {
      renderSettings({
        currentMultiTemplate: "@{user} が新規カード {newCards} を獲得！",
        currentMultiShowCards: false,
      });

      expect(await screen.findByText(NEW_CARD_WARNING_TEXT)).toBeInTheDocument();
    });

    it("is shown when multiShowCards is disabled and the template uses {newCardCount}", async () => {
      renderSettings({
        currentMultiTemplate: "@{user} が新規カードを{newCardCount}種類獲得！",
        currentMultiShowCards: false,
      });

      expect(await screen.findByText(NEW_CARD_WARNING_TEXT)).toBeInTheDocument();
    });

    it("toggles live as the user flips the multiShowCards checkbox", async () => {
      renderSettings({
        currentMultiTemplate: "@{user} が新規カード {newCards} を獲得！",
        currentMultiShowCards: true,
      });

      await screen.findByText("N連ガチャ用テンプレート（任意）");
      expect(screen.queryByText(NEW_CARD_WARNING_TEXT)).not.toBeInTheDocument();

      const checkbox = screen.getByRole("checkbox", { name: "N連通知にカード名一覧を含める" });
      fireEvent.click(checkbox);
      expect(await screen.findByText(NEW_CARD_WARNING_TEXT)).toBeInTheDocument();

      fireEvent.click(checkbox);
      expect(screen.queryByText(NEW_CARD_WARNING_TEXT)).not.toBeInTheDocument();
    });
  });
});
