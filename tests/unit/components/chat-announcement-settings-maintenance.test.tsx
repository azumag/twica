import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import ChatAnnouncementSettings from "@/components/ChatAnnouncementSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import { ChatReauthorizationProvider } from "@/lib/twitch/use-chat-reauthorization";
import jaMessages from "../../../messages/ja.json";

// ChatAnnouncementSettingsがIssue #827でuseRouterを利用するため、この保守モード専用
// テストでは副作用のないrefresh実装を注入し、既存のmaintenance境界だけを検証する。
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// #694 Stage 6c: ChatAnnouncementSettings の書き込み経路
// (POST /api/streamer/settings のテンプレート保存/有効化トグル) に対する
// maintenance統合テスト。

function renderSettings(status: MaintenanceStatusResponse) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <ChatReauthorizationProvider>
          <ChatAnnouncementSettings
            streamerId="streamer-1"
            currentEnabled={false}
            currentTemplate={null}
            currentMultiTemplate={null}
            currentMultiShowCards
            botAccount={null}
          />
        </ChatReauthorizationProvider>
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

describe("ChatAnnouncementSettings maintenance integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mode=off のときはテンプレート保存ボタンが操作可能（既存挙動を壊さない）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasScope: true }) })
    );
    renderSettings({ mode: "off" });

    const saveButton = await screen.findByRole("button", { name: "テンプレートを保存" });
    expect(saveButton).not.toBeDisabled();
    expect(screen.queryByText("メンテナンス中は操作できません")).not.toBeInTheDocument();
  });

  it("mode!=off のときはテンプレート保存ボタンがdisableされ、案内文言が表示される（事前disable）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasScope: true }) })
    );
    renderSettings({ mode: "read-only" });

    const saveButton = await screen.findByRole("button", { name: "テンプレートを保存" });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute("title", "メンテナンス中は操作できません");
    expect(screen.getByText("メンテナンス中は操作できません")).toBeInTheDocument();
  });

  it("事前disableをすり抜けてテンプレート保存が503(maintenance)で拒否された場合、サーバーの案内文言を表示する", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/check-scope")) {
        return { ok: true, json: async () => ({ hasScope: true }) };
      }
      return new Response(
        JSON.stringify({
          error: {
            code: "maintenance_read_only",
            message: "ただいまメンテナンス中です。しばらくしてから再度お試しください。",
            retryable: true,
          },
        }),
        { status: 503 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSettings({ mode: "off" });
    const saveButton = await screen.findByRole("button", { name: "テンプレートを保存" });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(
        screen.getByText("ただいまメンテナンス中です。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });
  });
});
