import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatAnnouncementSettings from "@/components/ChatAnnouncementSettings";
import { ChatReauthorizationProvider } from "@/lib/twitch/use-chat-reauthorization";
import jaMessages from "../../../messages/ja.json";

// Issue #827: mutation成功後のServer Component再取得を呼び出し単位で検証する。
// vi.mockのfactoryはホイストされるため、参照するモックもvi.hoistedで生成する。
const routerMocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

const ORIGINAL_LOCATION = window.location;

function stubLocationHref() {
  const current = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hash: current.hash,
      host: current.host,
      hostname: current.hostname,
      href: current.href,
      origin: current.origin,
      pathname: current.pathname,
      port: current.port,
      protocol: current.protocol,
      search: current.search,
    },
  });
}

function renderSettings(
  overrides: Partial<{
    currentTemplate: string | null;
    currentMultiTemplate: string | null;
    currentEnabled: boolean;
    botAccount: { username: string | null; displayName: string | null } | null;
  }> = {}
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <ChatReauthorizationProvider>
        <ChatAnnouncementSettings
          streamerId="streamer-1"
          currentEnabled={overrides.currentEnabled ?? false}
          currentTemplate={overrides.currentTemplate ?? null}
          currentMultiTemplate={overrides.currentMultiTemplate ?? null}
          botAccount={overrides.botAccount ?? null}
        />
      </ChatReauthorizationProvider>
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
    Object.defineProperty(window, "location", { value: ORIGINAL_LOCATION, configurable: true });
  });

  it("再認証APIの200応答に有効なTwitch loginUrlがなければ遷移せず翻訳済みエラーを表示する", async () => {
    stubLocationHref();
    const originalHref = window.location.href;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/auth/check-scope")) {
          return Promise.resolve(new Response(JSON.stringify({ hasScope: false }), { status: 200 }));
        }
        if (url.includes("/api/auth/reauth")) {
          return Promise.resolve(new Response(JSON.stringify({ state: "state-123" }), { status: 200 }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );
    renderSettings({ currentEnabled: true });

    fireEvent.click(await screen.findByRole("button", { name: "Twitchで再認証" }));

    expect(await screen.findByText("再認証に失敗しました")).toBeInTheDocument();
    expect(window.location.href).toBe(originalHref);
  });

  it("BOT接続APIの200応答に有効なTwitch loginUrlがなければ遷移せず翻訳済みエラーを表示する（Issue #865）", async () => {
    stubLocationHref();
    const originalHref = window.location.href;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/auth/check-scope")) {
          return Promise.resolve(new Response(JSON.stringify({ hasScope: true }), { status: 200 }));
        }
        if (url.includes("/api/auth/bot/connect")) {
          // origin/pathがTwitchの認可endpointと一致しない、侵害/バグ時を想定した応答
          return Promise.resolve(
            new Response(
              JSON.stringify({ success: true, loginUrl: "https://evil.example.com/phish", state: "state-123" }),
              { status: 200 }
            )
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );
    renderSettings({ currentEnabled: true });

    fireEvent.click(await screen.findByRole("button", { name: "連携する" }));

    expect(await screen.findByText("別アカウント連携の開始に失敗しました")).toBeInTheDocument();
    expect(window.location.href).toBe(originalHref);
  });

  it("shows template controls by default without the legacy advanced checkbox", async () => {
    renderSettings();

    expect(screen.queryByText("詳細設定を表示する")).not.toBeInTheDocument();
    expect(await screen.findByText("カスタムテンプレート（任意）")).toBeInTheDocument();
    expect(screen.getByText("N連ガチャ用テンプレート（任意）")).toBeInTheDocument();
    // Issue #1548: 「N連通知にカード名一覧を含める」チェックボックスは廃止。
    // カード名一覧の表示有無はテンプレートの {cards} 等の有無で決まるため、
    // フラグ用のUIが復活していないことをここで固定する。
    expect(screen.queryByText("N連通知にカード名一覧を含める")).not.toBeInTheDocument();
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

  it("shows {newCardsOrNone} in the multi-draw placeholder help and replaces it in the demo", async () => {
    renderSettings({
      currentMultiTemplate: "初入手: {newCardsOrNone}",
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
    });

    expect(await screen.findByTestId("multi-template-length-warning")).toBeInTheDocument();
    expect(screen.queryByTestId("single-template-length-warning")).not.toBeInTheDocument();
  });
});
