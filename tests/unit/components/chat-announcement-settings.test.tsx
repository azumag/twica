import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatAnnouncementSettings from "@/components/ChatAnnouncementSettings";
import jaMessages from "../../../messages/ja.json";

// Issue #827: mutation成功後のServer Component再取得を呼び出し単位で検証する。
// vi.mockのfactoryはホイストされるため、参照するモックもvi.hoistedで生成する。
const routerMocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

// next-intl unescapes the ICU '{'...'}' sequences from messages/ja.json into literal
// {newCards}/{newCardsOrNone}/{newCardCount} at render time, so the expectation here is the rendered
// text rather than the raw JSON string.
const NEW_CARD_WARNING_TEXT =
  "「N連通知にカード名一覧を含める」が無効なため、テンプレート内の {newCards} / {newCardsOrNone} / {newCardCount} は送信時に空文字に置き換わります。内容を表示したい場合は上のチェックボックスを有効にしてください。";

function renderSettings(
  overrides: Partial<{
    currentTemplate: string | null;
    currentMultiTemplate: string | null;
    currentMultiShowCards: boolean;
    currentEnabled: boolean;
    botAccount: { username: string | null; displayName: string | null } | null;
  }> = {}
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <ChatAnnouncementSettings
        streamerId="streamer-1"
        currentEnabled={overrides.currentEnabled ?? false}
        currentTemplate={overrides.currentTemplate ?? null}
        currentMultiTemplate={overrides.currentMultiTemplate ?? null}
        currentMultiShowCards={overrides.currentMultiShowCards ?? true}
        botAccount={overrides.botAccount ?? null}
      />
    </NextIntlClientProvider>
  );
}

describe("ChatAnnouncementSettings", () => {
  beforeEach(() => {
    routerMocks.refresh.mockReset();
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

  describe("Server Component refresh after delivery setting mutations (#827)", () => {
    // 初回check-scopeと設定POSTをURLで分岐し、対象mutationの成否を明示する。
    // これにより初回GET成功を設定保存成功と誤認するテストを避ける。
    function stubSettingsMutation(status: number) {
      const settingsPost = vi.fn(() =>
        new Response(JSON.stringify(status >= 400 ? { error: "設定更新失敗" } : {}), { status })
      );
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/api/auth/check-scope")) {
            return Promise.resolve(
              new Response(JSON.stringify({ hasScope: true }), { status: 200 })
            );
          }
          if (url.includes("/api/streamer/settings")) {
            return Promise.resolve(settingsPost());
          }
          throw new Error(`Unexpected fetch: ${url}`);
        })
      );
      return settingsPost;
    }

    it("通知OFFの保存成功後だけdashboardのServer Componentを再取得する", async () => {
      const settingsPost = stubSettingsMutation(200);
      renderSettings({ currentEnabled: true });

      const toggle = await screen.findByRole("checkbox", { name: "チャット通知を有効にする" });
      fireEvent.click(toggle);

      await waitFor(() => expect(settingsPost).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(routerMocks.refresh).toHaveBeenCalledTimes(1));
    });

    it("通知OFFの保存失敗時はServer Componentを再取得しない", async () => {
      const settingsPost = stubSettingsMutation(500);
      renderSettings({ currentEnabled: true });

      const toggle = await screen.findByRole("checkbox", { name: "チャット通知を有効にする" });
      fireEvent.click(toggle);

      await waitFor(() => expect(settingsPost).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(toggle).toBeChecked());
      expect(routerMocks.refresh).not.toHaveBeenCalled();
    });

    it("Bot切断成功後だけdashboardのServer Componentを再取得する", async () => {
      const settingsPost = stubSettingsMutation(200);
      renderSettings({ botAccount: { username: "twica-bot", displayName: "TwiCa Bot" } });

      fireEvent.click(await screen.findByRole("button", { name: "解除する" }));

      await waitFor(() => expect(settingsPost).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(routerMocks.refresh).toHaveBeenCalledTimes(1));
    });

    it("Bot切断失敗時はServer Componentを再取得しない", async () => {
      const settingsPost = stubSettingsMutation(500);
      renderSettings({ botAccount: { username: "twica-bot", displayName: "TwiCa Bot" } });

      fireEvent.click(await screen.findByRole("button", { name: "解除する" }));

      await waitFor(() => expect(settingsPost).toHaveBeenCalledTimes(1));
      await screen.findByText("設定更新失敗");
      expect(routerMocks.refresh).not.toHaveBeenCalled();
    });
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

    it("is shown when multiShowCards is disabled and the template uses {newCardsOrNone}", async () => {
      renderSettings({
        currentMultiTemplate: "@{user} が新規カード {newCardsOrNone} を獲得！",
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

  it("shows {newCardsOrNone} in the multi-draw placeholder help and replaces it in the demo", async () => {
    renderSettings({
      currentMultiTemplate: "初入手: {newCardsOrNone}",
      currentMultiShowCards: true,
    });

    expect(await screen.findByText(/\{newCardsOrNone\}=今回初めて獲得したカード名一覧/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "チャットデモ" }));
    expect(await screen.findByText("初入手: レジェンダリーカード、レアカード")).toBeInTheDocument();
  });

  it.each(["{cards}", "{newCards}", "{newCardsOrNone}"])(
    "shows the N連 length warning for the 15-card maximum of %s",
    async (placeholder) => {
      renderSettings({
        currentMultiTemplate: placeholder,
        currentMultiShowCards: true,
      });

      const multiTemplateSettings = await screen.findByTestId("multi-template-settings");
      const warning = within(multiTemplateSettings).getByTestId("multi-template-length-warning");
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent("カード名一覧・カード説明・URLなど");
    }
  );

  it("does not show an N連-only length warning under the single-draw template", async () => {
    renderSettings({
      currentTemplate: "@{user} が {card} を獲得しました！",
      currentMultiTemplate: "{newCardsOrNone}",
      currentMultiShowCards: true,
    });

    expect(await screen.findByTestId("multi-template-length-warning")).toBeInTheDocument();
    expect(screen.queryByTestId("single-template-length-warning")).not.toBeInTheDocument();
  });
});
