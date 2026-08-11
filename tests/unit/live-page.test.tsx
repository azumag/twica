import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getLiveDirectory: vi.fn(),
  getLiveDirectoryRankings: vi.fn(),
  getTranslations: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/live-directory", () => ({
  getLiveDirectory: mocks.getLiveDirectory,
  getLiveDirectoryRankings: mocks.getLiveDirectoryRankings,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
}));
vi.mock("@/components/LiveDirectory", () => ({
  default: ({ entries, rankings }: { entries: unknown[]; rankings: unknown[] }) => (
    <div data-testid="live-directory">
      entries:{entries.length};rankings:{rankings.length}
    </div>
  ),
}));
vi.mock("@/components/PublicFooter", () => ({
  default: () => <footer>public footer</footer>,
}));

import LivePage, { generateMetadata } from "@/app/live/page";

const translations: Record<string, Record<string, string>> = {
  livePage: {
    "metadata.title": "配信中 - TwiCa",
    "metadata.description": "metadata description",
    navigationLabel: "navigation",
    home: "ホーム",
    title: "配信中の配信者",
    description: "page description",
    consentNotice: "明示的に掲載を許可したチャネルだけが表示されています。",
    rankingNotice:
      "ランキングは全アクティブチャネルを集計対象とし、各指標の上位100件を、チャネル表示を許可していない場合は匿名で表示します。",
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
    mocks.getTranslations.mockReset();
    mocks.getTranslations.mockImplementation(async (namespace: string) => {
      return (key: string) => translations[namespace]?.[key] ?? key;
    });
    mocks.getLiveDirectory.mockResolvedValue([{ streamerId: "streamer-1" }]);
    mocks.getLiveDirectoryRankings.mockResolvedValue([{ identity: null }]);
  });

  it("renders the full directory without redirecting when no session exists", async () => {
    mocks.getSession.mockResolvedValue(null);

    render(await LivePage());

    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(mocks.getLiveDirectory).toHaveBeenCalledOnce();
    expect(mocks.getLiveDirectoryRankings).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "配信中の配信者" })).toBeInTheDocument();
    expect(screen.getByTestId("live-directory")).toHaveTextContent(
      "entries:1;rankings:1",
    );
    expect(
      screen.getByText("明示的に掲載を許可したチャネルだけが表示されています。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "ランキングは全アクティブチャネルを集計対象とし、各指標の上位100件を、チャネル表示を許可していない場合は匿名で表示します。",
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

  it("builds localized metadata from the livePage namespace", async () => {
    await expect(generateMetadata()).resolves.toEqual({
      title: "配信中 - TwiCa",
      description: "metadata description",
    });
  });
});
