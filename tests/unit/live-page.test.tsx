import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getLiveDirectory: vi.fn(),
  getLiveDirectoryRankings: vi.fn(),
  getEstimatedLiveChannelCount: vi.fn(),
  getTranslations: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/live-directory", () => ({
  getLiveDirectory: mocks.getLiveDirectory,
  getLiveDirectoryRankings: mocks.getLiveDirectoryRankings,
}));
vi.mock("@/lib/live-presence", () => ({
  getEstimatedLiveChannelCount: mocks.getEstimatedLiveChannelCount,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
}));
vi.mock("@/components/LiveDirectory", () => ({
  default: ({
    entries,
    rankings,
    estimatedLiveChannels,
  }: {
    entries: unknown[];
    rankings: { last7Days: unknown[]; allTime: unknown[] };
    estimatedLiveChannels: number | null;
  }) => (
    <div
      data-testid="live-directory"
      data-estimated={String(estimatedLiveChannels)}
    >
      entries:{entries.length};rankings:{rankings.last7Days.length}/{rankings.allTime.length}
    </div>
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
  },
  header: {
    dashboard: "ダッシュボード",
  },
};

describe("LivePage", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getLiveDirectory.mockReset();
    mocks.getLiveDirectoryRankings.mockReset();
    mocks.getEstimatedLiveChannelCount.mockReset();
    // 既定はスナップショット取得成功。障害系は専用テストで上書きする。
    mocks.getEstimatedLiveChannelCount.mockResolvedValue({ ok: true, count: 3 });
    mocks.getTranslations.mockReset();
    mocks.getTranslations.mockImplementation(async (namespace: string) => {
      return (key: string) => translations[namespace]?.[key] ?? key;
    });
    mocks.getLiveDirectory.mockResolvedValue([{ streamerId: "streamer-1" }]);
    mocks.getLiveDirectoryRankings.mockResolvedValue({
      last7Days: [{ identity: null }],
      allTime: [{ identity: null }, { identity: null }],
    });
  });

  it("renders the full directory without redirecting when no session exists", async () => {
    mocks.getSession.mockResolvedValue(null);

    render(await LivePage());

    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.getLiveDirectory).toHaveBeenCalledOnce();
    expect(mocks.getLiveDirectoryRankings).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", { name: "TwiCaチャネルとランキング" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("live-directory")).toHaveTextContent(
      "entries:1;rankings:1/2",
    );
    // #1114: presence取得は未ログインでも実行され、推定値がコンポーネントへ渡る。
    expect(mocks.getEstimatedLiveChannelCount).toHaveBeenCalledOnce();
    expect(screen.getByTestId("live-directory")).toHaveAttribute(
      "data-estimated",
      "3",
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
  });

  it("hides the estimate when the presence registry is unavailable", async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.getEstimatedLiveChannelCount.mockResolvedValue({ ok: false });

    render(await LivePage());

    // #1114: 障害時は「0」と誤表示せず、推定行ごと非表示（null）になる。
    expect(screen.getByTestId("live-directory")).toHaveAttribute(
      "data-estimated",
      "null",
    );
  });

  it("uses the dashboard header route for an authenticated visitor", async () => {
    mocks.getSession.mockResolvedValue({ twitchUserId: "user-1" });

    render(await LivePage());

    expect(screen.getByRole("link", { name: "ダッシュボード" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });

  it("builds localized metadata from the livePage namespace", async () => {
    await expect(generateMetadata()).resolves.toEqual({
      title: "チャネルとランキング - TwiCa",
      description: "metadata description",
    });
  });
});
