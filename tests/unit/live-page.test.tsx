import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
  getLiveDirectory: vi.fn(),
  getLiveDirectoryPresence: vi.fn(),
  getLiveDirectoryRankings: vi.fn(),
  getTranslations: vi.fn(),
  getUnreadAnnouncements: vi.fn(),
  getUserPlanSnapshot: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: mocks.getSession,
  canUseStreamerFeatures: mocks.canUseStreamerFeatures,
}));
vi.mock("@/lib/live-directory", () => ({
  getLiveDirectory: mocks.getLiveDirectory,
  getLiveDirectoryPresence: mocks.getLiveDirectoryPresence,
  getLiveDirectoryRankings: mocks.getLiveDirectoryRankings,
}));
vi.mock("@/lib/announcements", () => ({
  getUnreadAnnouncements: mocks.getUnreadAnnouncements,
}));
vi.mock("@/lib/plan", () => ({
  getUserPlanSnapshot: mocks.getUserPlanSnapshot,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
}));
vi.mock("@/components/LiveDirectory", () => ({
  default: ({
    entries,
    rankings,
  }: {
    entries: unknown[];
    rankings: { last7Days: unknown[]; allTime: unknown[] };
  }) => (
    <div data-testid="live-directory">
      entries:{entries.length};rankings:{rankings.last7Days.length}/{rankings.allTime.length}
    </div>
  ),
}));
vi.mock("@/components/Header", () => ({
  default: ({
    unreadAnnouncementsCount,
  }: {
    session: unknown;
    unreadAnnouncementsCount?: number;
  }) => (
    <header
      data-testid="app-header"
      data-unread={String(unreadAnnouncementsCount ?? 0)}
    >
      app header
    </header>
  ),
}));
vi.mock("@/components/DashboardNav", () => ({
  default: ({
    isStreamer,
    isSupporter,
  }: {
    isStreamer: boolean;
    isSupporter: boolean;
  }) => (
    <nav
      data-testid="dashboard-nav"
      data-streamer={String(isStreamer)}
      data-supporter={String(isSupporter)}
    >
      dashboard nav
    </nav>
  ),
}));
vi.mock("@/components/PublicFooter", () => ({
  default: () => <footer>public footer</footer>,
}));

import LivePage, { generateMetadata } from "@/app/live/page";

const translations: Record<string, Record<string, string>> = {
  livePage: {
    "metadata.title": "チャネルとランキング - TwiCa",
    "metadata.description": "metadata description",
    navigationLabel: "navigation",
    home: "ホーム",
    title: "TwiCaチャネルとランキング",
    description: "page description",
    consentNotice: "明示的に掲載を許可したチャネルだけが表示されています。",
    rankingNotice:
      "ランキングは全アクティブチャネルを集計対象とし、選択した期間の各指標上位100件を、チャネル表示を許可していない場合は匿名で表示します。",
    liveCount: "現在配信中チャネル数（overlay接続ベースの推定・下限）：約{count}件",
    liveCountNote:
      "設定画面で発行した認証済みoverlay URLを新しくコピーした接続だけを基にした概算で、既存のOBS URLは再コピーが必要です。5件単位に切り捨てています。polling-onlyは含まれず、残留タブや切断遅延は含まれるため実際の配信数とは差が生じます。設定画面のプレビューは含まれません。反映に最大17分程度かかる場合があります。",
  },
};

describe("LivePage", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.canUseStreamerFeatures.mockReset();
    mocks.getLiveDirectory.mockReset();
    mocks.getLiveDirectoryPresence.mockReset();
    mocks.getLiveDirectoryRankings.mockReset();
    mocks.getTranslations.mockReset();
    mocks.getUnreadAnnouncements.mockReset();
    mocks.getUserPlanSnapshot.mockReset();
    mocks.getTranslations.mockImplementation(async (namespace: string) => {
      return (key: string, values?: Record<string, unknown>) => {
        const template = translations[namespace]?.[key] ?? key;
        return Object.entries(values ?? {}).reduce(
          (text, [name, value]) => text.replace(`{${name}}`, String(value)),
          template,
        );
      };
    });
    mocks.getLiveDirectory.mockResolvedValue([{ streamerId: "streamer-1" }]);
    mocks.getLiveDirectoryPresence.mockResolvedValue(null);
    mocks.getLiveDirectoryRankings.mockResolvedValue({
      last7Days: [{ identity: null }],
      allTime: [{ identity: null }, { identity: null }],
    });
    mocks.canUseStreamerFeatures.mockReturnValue(true);
    mocks.getUnreadAnnouncements.mockResolvedValue([{}, {}]);
    mocks.getUserPlanSnapshot.mockResolvedValue("patron");
  });

  it("renders the full directory with the public header without redirecting when no session exists", async () => {
    mocks.getSession.mockResolvedValue(null);

    render(await LivePage());

    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.getLiveDirectory).toHaveBeenCalledOnce();
    expect(mocks.getLiveDirectoryPresence).toHaveBeenCalledOnce();
    expect(mocks.getLiveDirectoryRankings).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "TwiCaチャネルとランキング" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("live-directory")).toHaveTextContent(
      "entries:1;rankings:1/2",
    );
    expect(
      screen.getByText("明示的に掲載を許可したチャネルだけが表示されています。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "ランキングは全アクティブチャネルを集計対象とし、選択した期間の各指標上位100件を、チャネル表示を許可していない場合は匿名で表示します。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ホーム" })).toHaveAttribute("href", "/");
    expect(screen.getByText("public footer")).toBeInTheDocument();

    // #945: 未ログイン時は公開ヘッダーのみ。アプリHeader/ダッシュボードナビは出ない。
    expect(screen.queryByTestId("app-header")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-nav")).not.toBeInTheDocument();
    // 未ログインではヘッダー導線用のDB照会を行わない。
    expect(mocks.getUnreadAnnouncements).not.toHaveBeenCalled();
    expect(mocks.getUserPlanSnapshot).not.toHaveBeenCalled();
  });

  it("renders the dashboard Header and DashboardNav for an authenticated visitor (#945)", async () => {
    mocks.getSession.mockResolvedValue({ twitchUserId: "user-1" });

    render(await LivePage());

    // ダッシュボードレイアウトと同じHeader+DashboardNavが描画され、
    // 公開ヘッダーの「ホーム」導線は消える。
    const appHeader = screen.getByTestId("app-header");
    expect(appHeader).toHaveAttribute("data-unread", "2");
    const nav = screen.getByTestId("dashboard-nav");
    expect(nav).toHaveAttribute("data-streamer", "true");
    expect(nav).toHaveAttribute("data-supporter", "true");
    expect(screen.queryByRole("link", { name: "ホーム" })).not.toBeInTheDocument();
    expect(screen.getByText("public footer")).toBeInTheDocument();

    // ダッシュボードレイアウトと同じく未読数・プラン判定を1回ずつ要求する。
    expect(mocks.getUnreadAnnouncements).toHaveBeenCalledWith("user-1");
    expect(mocks.getUserPlanSnapshot).toHaveBeenCalledWith("user-1");
  });

  it("passes basic plan and non-streamer flags to the dashboard nav", async () => {
    mocks.getSession.mockResolvedValue({ twitchUserId: "user-2" });
    mocks.canUseStreamerFeatures.mockReturnValue(false);
    mocks.getUserPlanSnapshot.mockResolvedValue("basic");
    mocks.getUnreadAnnouncements.mockResolvedValue([]);

    render(await LivePage());

    expect(screen.getByTestId("app-header")).toHaveAttribute("data-unread", "0");
    expect(screen.getByTestId("dashboard-nav")).toHaveAttribute("data-streamer", "false");
    expect(screen.getByTestId("dashboard-nav")).toHaveAttribute("data-supporter", "false");
  });

  it("shows the estimate only when the presence snapshot is positive", async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.getLiveDirectoryPresence.mockResolvedValue({
      count: 5,
      observedAt: "2026-08-21T00:00:00.000Z",
    });

    render(await LivePage());

    expect(screen.getByTestId("live-presence-estimate")).toHaveTextContent(
      "現在配信中チャネル数（overlay接続ベースの推定・下限）：約5件",
    );
    expect(screen.getByTestId("live-presence-estimate")).toHaveTextContent(
      "polling-onlyは含まれず、残留タブや切断遅延は含まれる",
    );
    expect(screen.getByTestId("live-presence-estimate")).toHaveTextContent(
      "設定画面のプレビューは含まれません",
    );
  });

  it("hides a zero overlay estimate that could contradict polling-only live entries", async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.getLiveDirectoryPresence.mockResolvedValue({
      count: 0,
      observedAt: "2026-08-21T00:00:00.000Z",
    });

    render(await LivePage());

    expect(screen.queryByTestId("live-presence-estimate")).not.toBeInTheDocument();
    expect(screen.getByTestId("live-directory")).toHaveTextContent("entries:1");
  });

  it("builds localized metadata from the livePage namespace", async () => {
    await expect(generateMetadata()).resolves.toEqual({
      title: "チャネルとランキング - TwiCa",
      description: "metadata description",
    });
  });
});
