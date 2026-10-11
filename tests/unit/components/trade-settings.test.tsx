import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TradeSettings from "@/components/TradeSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

function renderSettings({
  tradeEnabled = false,
  crossChannelTradeEnabled = false,
}: {
  tradeEnabled?: boolean;
  crossChannelTradeEnabled?: boolean;
} = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider
        value={{ mode: "off" } as unknown as MaintenanceStatusResponse}
      >
        <TradeSettings
          streamerId="streamer-1"
          currentTradeEnabled={tradeEnabled}
          currentCrossChannelTradeEnabled={crossChannelTradeEnabled}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>,
  );
}

describe("TradeSettings (#725)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("explains that unowned-card trading requires collection visibility without a redundant link", () => {
    renderSettings();

    expect(screen.getByText(jaMessages.tradeSettings.visibilityNotice)).toBeInTheDocument();
    // 公開設定カードは同じ画面のすぐ上にあるため、注記にリンクは置かない。
    expect(screen.queryByRole("link")).toBeNull();
  });

  // #1779 のレビュー指摘: 注記が参照する見出し・トグル名が実在するかを固定する。
  // 表示一致の assert だけでは「存在しないセクション名」を書いても green だった。
  it("quotes only headings and toggle labels that actually exist", () => {
    const notice = jaMessages.tradeSettings.visibilityNotice;
    const visibility = jaMessages.cardVisibilitySettings;

    // 注記が引用する見出しは CardVisibilitySettings の <h2>（t("title")）実値と一致する。
    expect(notice).toContain(visibility.title);
    // 参照するトグルは form.showUnowned / form.showDetails の実値と一致する。
    expect(notice).toContain(visibility.form.showUnowned);
    expect(notice).toContain(visibility.form.showDetails);
  });

  it("disables cross-channel toggle while the master trade toggle is off", () => {
    renderSettings({ tradeEnabled: false, crossChannelTradeEnabled: true });

    expect(
      screen.getByRole("checkbox", {
        name: jaMessages.tradeSettings.form.tradeEnabled,
      }),
    ).not.toBeDisabled();

    const crossToggle = screen.getByRole("checkbox", {
      name: jaMessages.tradeSettings.form.crossChannelEnabled,
    });
    expect(crossToggle).toBeChecked();
    expect(crossToggle).toBeDisabled();
  });

  it("optimistically enables trading and sends only the changed key", async () => {
    renderSettings();

    const tradeToggle = screen.getByRole("checkbox", {
      name: jaMessages.tradeSettings.form.tradeEnabled,
    });
    fireEvent.click(tradeToggle);

    expect(tradeToggle).toBeChecked();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/streamer/settings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            streamerId: "streamer-1",
            tradeEnabled: true,
          }),
        }),
      );
    });

    expect(
      screen.getByRole("checkbox", {
        name: jaMessages.tradeSettings.form.crossChannelEnabled,
      }),
    ).not.toBeDisabled();
  });

  it("rolls back an optimistic cross-channel toggle when save fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "save failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderSettings({ tradeEnabled: true, crossChannelTradeEnabled: false });

    const crossToggle = screen.getByRole("checkbox", {
      name: jaMessages.tradeSettings.form.crossChannelEnabled,
    });
    fireEvent.click(crossToggle);
    expect(crossToggle).toBeChecked();

    await waitFor(() => {
      expect(crossToggle).not.toBeChecked();
    });
    expect(screen.getByText("save failed")).toBeInTheDocument();
  });
});
