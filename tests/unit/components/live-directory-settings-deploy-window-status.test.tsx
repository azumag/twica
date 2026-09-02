import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import LiveDirectorySettings from "@/components/LiveDirectorySettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

describe("LiveDirectorySettings deploy-window status", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, liveDirectorySettingsSkippedDeployWindow: true }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the deploy-window error in the existing status region", async () => {
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <MaintenanceStatusContext.Provider value={{ mode: "off" }}>
          <LiveDirectorySettings
            streamerId="streamer-1"
            currentPublishLiveStatus={false}
            currentPublishStats={false}
          />
        </MaintenanceStatusContext.Provider>
      </NextIntlClientProvider>
    );

    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();

    const liveToggle = screen.getByRole("checkbox", { name: "配信中を公表する" });
    fireEvent.click(liveToggle);

    await waitFor(() => {
      expect(status).toHaveTextContent(
        "配信中ページの設定を現在保存できません。しばらくしてから再度お試しください。"
      );
    });
    expect(screen.getByRole("status")).toBe(status);
    expect(liveToggle).not.toBeChecked();
  });
});
