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

// 表示順ではなくユーザーが認識するラベルで取得し、トグルのアクセシビリティ契約も
// 各操作テストで同時に保証する。
function getLiveToggle() {
  return screen.getByRole("checkbox", { name: "配信中を公表する" });
}

function getRankingToggle() {
  return screen.getByRole("checkbox", { name: "ランキングにチャネルを表示する" });
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

  it("links the description to the live directory", () => {
    renderSettings({});

    expect(screen.getByRole("link", { name: "配信中ページ" })).toHaveAttribute("href", "/live");
  });

  it("defaults both independent toggles to off and keeps both operable", () => {
    renderSettings({});

    const liveToggle = getLiveToggle();
    const rankingToggle = getRankingToggle();
    expect(liveToggle).not.toBeChecked();
    expect(liveToggle).toBeEnabled();
    expect(rankingToggle).not.toBeChecked();
    expect(rankingToggle).toBeEnabled();
    expect(rankingToggle).toHaveAccessibleDescription(/オフでも.*匿名.*ランキング/);
  });

  it("turning listing on saves only publishLiveStatus", async () => {
    renderSettings({});
    fireEvent.click(getLiveToggle());

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
    expect(getRankingToggle()).not.toBeChecked();
    expect(getRankingToggle()).toBeEnabled();
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
    fireEvent.click(getLiveToggle());

    await waitFor(() => {
      expect(
        screen.getByText("配信中ページの設定を現在保存できません。しばらくしてから再度お試しください。")
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("配信中ページへの掲載設定をオンにしました")).not.toBeInTheDocument();
    expect(getLiveToggle()).not.toBeChecked();
  });

  it("turning listing off preserves the independent ranking setting", async () => {
    renderSettings({ publishLiveStatus: true, publishStats: true });
    fireEvent.click(getLiveToggle());

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/streamer/settings",
        expect.objectContaining({
          body: JSON.stringify({ streamerId: "streamer-1", publishLiveStatus: false }),
        })
      );
    });
    expect(getRankingToggle()).toBeChecked();
    expect(getRankingToggle()).toBeEnabled();
  });

  it("turning ranking display on while live listing is off sends only publishStats", async () => {
    renderSettings({ publishLiveStatus: false, publishStats: false });
    fireEvent.click(getRankingToggle());

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
    expect(getLiveToggle()).toBeDisabled();
    expect(getRankingToggle()).toBeDisabled();
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
    const liveToggle = getLiveToggle();
    fireEvent.click(liveToggle);

    await waitFor(() => {
      expect(screen.getByText("サーバーエラー")).toBeInTheDocument();
    });
    // 失敗時は楽観反映を巻き戻す
    expect(liveToggle).not.toBeChecked();
  });
});
