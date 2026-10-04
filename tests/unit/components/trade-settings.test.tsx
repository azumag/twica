import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TradeSettings from "@/components/TradeSettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import { COLLECTION_VISIBILITY_ANCHOR_ID } from "@/lib/constants";
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

  it("explains that unowned-card trading requires collection visibility and links to it", () => {
    renderSettings();

    expect(screen.getByText(new RegExp(jaMessages.tradeSettings.visibilityNotice.slice(0, 20)))).toBeInTheDocument();
    // リンク先は CardVisibilitySettings のルート要素 id と同じ定数で揃えている。
    const link = screen.getByRole("link", {
      name: jaMessages.tradeSettings.visibilityNoticeLink,
    });
    expect(link).toHaveAttribute("href", `#${COLLECTION_VISIBILITY_ANCHOR_ID}`);
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
