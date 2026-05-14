import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatAnnouncementSettings from "@/components/ChatAnnouncementSettings";
import jaMessages from "../../../messages/ja.json";

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <ChatAnnouncementSettings
        streamerId="streamer-1"
        currentEnabled={false}
        currentTemplate={null}
        currentMultiTemplate={null}
        currentMultiShowCards={true}
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
});
