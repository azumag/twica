import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import LiveDirectorySettings from "@/components/LiveDirectorySettings";
import { MaintenanceStatusContext } from "@/components/MaintenanceStatusProvider";
import type { MaintenanceStatusResponse } from "@/lib/maintenance/client";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/lib/logger");

function renderSettings(
  current: { publishLiveStatus?: boolean; publishStats?: boolean },
  status: MaintenanceStatusResponse = { mode: "off" }
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MaintenanceStatusContext.Provider value={status}>
        <LiveDirectorySettings
          streamerId="streamer-1"
          currentPublishLiveStatus={current.publishLiveStatus ?? false}
          currentPublishStats={current.publishStats ?? false}
        />
      </MaintenanceStatusContext.Provider>
    </NextIntlClientProvider>
  );
}

// トグルのラベルテキストは<label>要素の外側（兄弟<span>）にあり、アクセシブルネームが
// 付いていない既存マークアップ（CardVisibilitySettings 踏襲）のため、表示順
// （0: 配信中を公表する, 1: 統計を公開する）を前提にインデックスで取得する。
function getToggles() {
  return screen.getAllByRole("checkbox");
}

describe("LiveDirectorySettings", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to both toggles off and disables stats until listing is on", () => {
    renderSettings({});
    const [liveToggle, statsToggle] = getToggles();
    expect(liveToggle).not.toBeChecked();
    expect(statsToggle).toBeDisabled();
    expect(screen.getByText(/「配信中を公表する」が必要/)).toBeInTheDocument();
  });

  it("enables the stats toggle once listing is on", () => {
    renderSettings({ publishLiveStatus: true });
    const [, statsToggle] = getToggles();
    expect(statsToggle).not.toBeDisabled();
  });

  it("turning listing on saves publishLiveStatus and enables stats", async () => {
    renderSettings({});
    const [liveToggle] = getToggles();
    fireEvent.click(liveToggle);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/streamer/settings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ streamerId: "streamer-1", publishLiveStatus: true }),
        })
      );
    });
    expect(screen.getByText("配信中ページへの掲載設定をオンにしました")).toBeInTheDocument();
    const [, statsToggle] = getToggles();
    expect(statsToggle).not.toBeDisabled();
  });

  it("shows an error and keeps the toggle off when the server skips the deploy-window write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, liveDirectorySettingsSkippedDeployWindow: true }),
      })
    );
    renderSettings({});
    const [liveToggle] = getToggles();
    fireEvent.click(liveToggle);

    await waitFor(() => {
      expect(
        screen.getByText("配信中ページの設定を現在保存できません。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("配信中ページへの掲載設定をオンにしました")).not.toBeInTheDocument();
    const [liveToggleAfter] = getToggles();
    expect(liveToggleAfter).not.toBeChecked();
  });

  it("turning listing off also resets stats and disables it", async () => {
    renderSettings({ publishLiveStatus: true, publishStats: true });
    const [liveToggle] = getToggles();
    fireEvent.click(liveToggle);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/streamer/settings",
        expect.objectContaining({
          body: JSON.stringify({
            streamerId: "streamer-1",
            publishLiveStatus: false,
            publishStats: false,
          }),
        })
      );
    });
    // 保存完了後に publishStats=false が反映されるため、fetch の呼び出しだけでなく
    // 依存トグルの最終状態まで待って、非同期な UI 契約を検証する。
    await waitFor(() => {
      const [, statsToggle] = getToggles();
      expect(statsToggle).toBeDisabled();
      expect(statsToggle).not.toBeChecked();
    });
  });

  it("toggling stats alone sends only publishStats", async () => {
    renderSettings({ publishLiveStatus: true, publishStats: false });
    const [, statsToggle] = getToggles();
    fireEvent.click(statsToggle);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/streamer/settings",
        expect.objectContaining({
          body: JSON.stringify({ streamerId: "streamer-1", publishStats: true }),
        })
      );
    });
  });

  it("mode!=off disables both toggles and shows the maintenance notice", () => {
    renderSettings({ publishLiveStatus: true }, { mode: "read-only" });
    const [liveToggle, statsToggle] = getToggles();
    expect(liveToggle).toBeDisabled();
    expect(statsToggle).toBeDisabled();
    expect(screen.getByText("メンテナンス中は操作できません")).toBeInTheDocument();
  });

  it("shows the server error message when saving fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "サーバーエラー" }),
      })
    );
    renderSettings({});
    const [liveToggle] = getToggles();
    fireEvent.click(liveToggle);

    await waitFor(() => {
      expect(screen.getByText("サーバーエラー")).toBeInTheDocument();
    });
    // 失敗時は楽観反映を巻き戻す
    expect(liveToggle).not.toBeChecked();
  });
});
