import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getLiveDirectory: vi.fn(),
  getLiveDirectoryPresence: vi.fn(),
  getLiveDirectoryRankings: vi.fn(),
  getTranslations: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/live-directory", () => ({
  getLiveDirectory: mocks.getLiveDirectory,
  getLiveDirectoryPresence: mocks.getLiveDirectoryPresence,
  getLiveDirectoryRankings: mocks.getLiveDirectoryRankings,
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
    liveCount: "現在配信中チャネル数（推定）：約{count}件",
    liveCountNote:
      "overlay接続だけを基にした概算です。polling-onlyは含まれず、設定画面のプレビューや残留タブは含まれるため実際の配信数とは差が生じます。反映に十数分かかる場合があります。",
  },
  header: {
    dashboard: "ダッシュボード",
  },
};

describe("LivePage", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.getLiveDirectory.mockReset();
    mocks.getLiveDirectoryPresence.mockReset();
    mocks.getLiveDirectoryRankings.mockReset();
    mocks.getTranslations.mockReset();
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
  });

  it("renders the full directory without redirecting when no session exists", async () => {
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
  });

  it("uses the dashboard header route for an authenticated visitor", async () => {
    mocks.getSession.mockResolvedValue({ twitchUserId: "user-1" });

    render(await LivePage());

    expect(screen.getByRole("link", { name: "ダッシュボード" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });

  it("shows the estimate only when the presence snapshot is available", async () => {
    mocks.getSession.mockResolvedValue(null);
    mocks.getLiveDirectoryPresence.mockResolvedValue({
      count: 7,
      observedAt: "2026-08-21T00:00:00.000Z",
    });

    render(await LivePage());

    expect(screen.getByTestId("live-presence-estimate")).toHaveTextContent(
      "現在配信中チャネル数（推定）：約7件",
    );
    expect(screen.getByTestId("live-presence-estimate")).toHaveTextContent(
      "polling-onlyは含まれず、設定画面のプレビューや残留タブは含まれる",
    );
  });

  it("builds localized metadata from the livePage namespace", async () => {
    await expect(generateMetadata()).resolves.toEqual({
      title: "チャネルとランキング - TwiCa",
      description: "metadata description",
    });
  });
});
