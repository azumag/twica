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

  // #2070 フォローアップ (C4b): トレード限定の「名前だけ公開」トグルは廃止。
  // 未所持カードの見え方はコレクション公開設定に一本化し、この画面からは
  // 同じページ内のセクションへ案内する。
  it("explains that unowned-card visibility follows the collection visibility section", () => {
    renderSettings();

    expect(
      screen.getByText(
        jaMessages.tradeSettings.visibilityNotice.replace(
          "{itemsTitle}",
          jaMessages.cardVisibilitySettings.form.itemsTitle,
        ),
      ),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: jaMessages.tradeSettings.visibilityNoticeLink.replace(
        "{itemsTitle}",
        jaMessages.cardVisibilitySettings.form.itemsTitle,
      ),
    });
    expect(link).toHaveAttribute("href", "#collection-sharing-heading");
  });

  it("no longer renders the retired name-only toggle", () => {
    renderSettings({ tradeEnabled: true });

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(
      screen.queryByText(
        jaMessages.cardVisibilitySettings.form.itemsTitle,
        { selector: "label" },
      ),
    ).toBeNull();
    // 旧キー自体が messages から撤去されている（文言の再流入防止）。
    expect("unownedCardNamesVisible" in jaMessages.tradeSettings.form).toBe(false);
  });

  // #1779 のレビュー指摘: 注記が参照する見出し・トグル名が実在するかを固定する。
  it("quotes only headings and toggle labels that actually exist", () => {
    const notice = jaMessages.tradeSettings.visibilityNotice;
    const visibility = jaMessages.cardVisibilitySettings;

    // 注記が引用する見出しは CardVisibilitySettings の項目セクション実値と一致する。
    expect(notice).toContain("{itemsTitle}");
    expect(visibility.form.itemsTitle).toBeTruthy();
    // トレード設定側に旧「名前だけ公開」の文言が残っていない。
    expect(JSON.stringify(jaMessages.tradeSettings)).not.toContain("名前だけ");
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
