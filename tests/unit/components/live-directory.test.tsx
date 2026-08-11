import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import LiveDirectory, {
  getCompetitionRanks,
  sortLiveDirectoryEntries,
  sortLiveDirectoryRankings,
} from "@/components/LiveDirectory";
import type {
  LiveDirectoryEntry,
  LiveDirectoryRankingEntry,
} from "@/lib/live-directory";
import jaMessages from "../../../messages/ja.json";

const REFERENCE_TIME = "2026-08-11T03:00:00Z";

function entry(
  id: string,
  overrides: Partial<LiveDirectoryEntry> = {},
): LiveDirectoryEntry {
  return {
    streamerId: id,
    twitchUserId: `twitch-${id}`,
    twitchLogin: id,
    displayName: id,
    profileImageUrl: `https://example.com/${id}-profile.png`,
    title: `${id} stream`,
    gameName: "Game",
    viewerCount: 0,
    startedAt: "2026-08-11T01:00:00Z",
    thumbnailUrl: `https://example.com/${id}-thumbnail.jpg`,
    ...overrides,
  };
}

const entries = [
  entry("alpha", {
    displayName: "Alpha",
    viewerCount: 20,
    startedAt: "2026-08-11T01:30:00Z",
  }),
  entry("bravo", {
    displayName: "Bravo",
    viewerCount: 50,
    startedAt: "2026-08-11T02:30:00Z",
  }),
  entry("charlie", {
    displayName: "Charlie",
    viewerCount: 10,
    startedAt: "2026-08-11T02:00:00Z",
  }),
];

const rankings: LiveDirectoryRankingEntry[] = [
  {
    identity: {
      twitchLogin: "alpha",
      displayName: "Alpha",
      profileImageUrl: "https://example.com/alpha-profile.png",
    },
    cardCount: 4,
    redemptionCount: 90,
    totalPoints: 9000,
    rankedMetrics: ["cardCount", "redemptionCount", "totalPoints"],
  },
  {
    identity: null,
    cardCount: 12,
    redemptionCount: 30,
    totalPoints: 30000,
    rankedMetrics: ["cardCount", "redemptionCount", "totalPoints"],
  },
  {
    identity: {
      twitchLogin: "charlie",
      displayName: "Charlie",
      profileImageUrl: "",
    },
    cardCount: 12,
    redemptionCount: 30,
    totalPoints: 3000,
    rankedMetrics: ["cardCount", "redemptionCount", "totalPoints"],
  },
];

function renderDirectory(
  streamItems: LiveDirectoryEntry[] = entries,
  rankingItems: LiveDirectoryRankingEntry[] = rankings,
  recentRankingItems: LiveDirectoryRankingEntry[] = rankingItems,
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <LiveDirectory
        entries={streamItems}
        rankings={{
          last7Days: recentRankingItems,
          allTime: rankingItems,
        }}
        referenceTime={REFERENCE_TIME}
      />
    </NextIntlClientProvider>,
  );
}

function renderedCardIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("article[data-streamer-id]")].map(
    (card) => card.getAttribute("data-streamer-id") ?? "",
  );
}

function rankingIds(items: LiveDirectoryRankingEntry[]): string[] {
  return items.map((item) => item.identity?.twitchLogin ?? "anonymous");
}

describe("live directory ordering", () => {
  it("sorts start timestamps newest-first without mutating the input", () => {
    const snapshot = [...entries];

    expect(sortLiveDirectoryEntries(entries).map((item) => item.streamerId)).toEqual([
      "bravo",
      "charlie",
      "alpha",
    ]);
    expect(entries).toEqual(snapshot);
  });

  it("places invalid startedAt values last without returning an unstable NaN comparator", () => {
    const invalid = entry("invalid", { startedAt: "not-a-date", viewerCount: 100 });
    const valid = entry("valid", {
      startedAt: "2026-08-11T02:00:00Z",
      viewerCount: 1,
    });

    expect(
      sortLiveDirectoryEntries([invalid, valid]).map((item) => item.streamerId),
    ).toEqual(["valid", "invalid"]);
  });

  it("does not use viewer count as a hidden start-time tie-breaker", () => {
    const alpha = entry("alpha", { displayName: "Alpha", viewerCount: 1 });
    const bravo = entry("bravo", { displayName: "Bravo", viewerCount: 999 });

    expect(
      sortLiveDirectoryEntries([bravo, alpha]).map((item) => item.streamerId),
    ).toEqual(["alpha", "bravo"]);
  });

  it("sorts all three ranking metrics and keeps anonymous rows in the ranking", () => {
    expect(rankingIds(sortLiveDirectoryRankings(rankings, "redemptionCount"))).toEqual([
      "alpha",
      "charlie",
      "anonymous",
    ]);
    expect(rankingIds(sortLiveDirectoryRankings(rankings, "totalPoints"))).toEqual([
      "anonymous",
      "alpha",
      "charlie",
    ]);
    expect(rankingIds(sortLiveDirectoryRankings(rankings, "cardCount"))).toEqual([
      "charlie",
      "anonymous",
      "alpha",
    ]);
  });

  it("uses competition ranks for tied values", () => {
    const sorted = sortLiveDirectoryRankings(rankings, "cardCount");
    expect(getCompetitionRanks(sorted, "cardCount")).toEqual([1, 1, 3]);
  });
});

describe("LiveDirectory", () => {
  it("shows four horizontal tabs and uses the start-time view initially", () => {
    const { container } = renderDirectory();

    expect(screen.getByRole("tablist", { name: "表示内容" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "開始日時順",
      "カード引き換え数ランキング",
      "チャネルポイントランキング",
      "種類数ランキング",
    ]);
    expect(screen.getByRole("tab", { name: "開始日時順" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(renderedCardIds(container)).toEqual(["bravo", "charlie", "alpha"]);
  });

  it("switches to a ranking, displays values, and keeps opted-out channels anonymous", () => {
    renderDirectory();
    fireEvent.click(screen.getByRole("tab", { name: "チャネルポイントランキング" }));

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("1位")).toBeInTheDocument();
    expect(within(rows[0]).getByText("匿名チャネル")).toBeInTheDocument();
    expect(within(rows[0]).getByText("30,000ポイント")).toBeInTheDocument();
    expect(within(rows[0]).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("must-not-leak")).not.toBeInTheDocument();

    const alphaLink = screen.getByRole("link", { name: /AlphaをTwitchで見る/ });
    expect(alphaLink).toHaveAttribute("href", "https://www.twitch.tv/alpha");
    expect(alphaLink).toHaveAttribute("target", "_blank");
    expect(alphaLink).toHaveAttribute("rel", "noopener noreferrer");
    // 可視名とsr-onlyの操作説明がリンク名を担うため、avatarは三重読み上げを
    // 避ける装飾画像として扱う。
    expect(alphaLink.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("switches ranking aggregation between all time and the last 7 days", () => {
    const recentRankings: LiveDirectoryRankingEntry[] = [
      {
        identity: rankings[0].identity,
        cardCount: 1,
        redemptionCount: 2,
        totalPoints: 345,
        rankedMetrics: ["cardCount", "redemptionCount", "totalPoints"],
      },
    ];
    renderDirectory(entries, rankings, recentRankings);
    fireEvent.click(screen.getByRole("tab", { name: "チャネルポイントランキング" }));

    expect(screen.getByRole("group", { name: "集計期間" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "全期間" })).toBeChecked();
    expect(screen.getByText("30,000ポイント")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "直近7日間" }));

    expect(screen.getByRole("radio", { name: "直近7日間" })).toBeChecked();
    expect(screen.getByText("345ポイント")).toBeInTheDocument();
    expect(
      screen.getByText("直近7日間に記録されたカード引き換えを集計しています。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "種類数ランキング" }));
    expect(
      screen.getByText("直近7日間に追加され、現在も有効なカード種類数です。"),
    ).toBeInTheDocument();
  });

  it("excludes rows outside each metric candidate set before calculating ranks", () => {
    const metricScopedRankings: LiveDirectoryRankingEntry[] = [
      {
        identity: rankings[0].identity,
        cardCount: 999,
        redemptionCount: 10,
        totalPoints: 999,
        rankedMetrics: ["redemptionCount"],
      },
      {
        identity: null,
        cardCount: 999,
        redemptionCount: 999,
        totalPoints: 20,
        rankedMetrics: ["totalPoints"],
      },
      {
        identity: rankings[2].identity,
        cardCount: 30,
        redemptionCount: 999,
        totalPoints: 999,
        rankedMetrics: ["cardCount"],
      },
    ];
    renderDirectory([], metricScopedRankings);

    fireEvent.click(screen.getByRole("tab", { name: "カード引き換え数ランキング" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("1位")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "チャネルポイントランキング" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("匿名チャネル")).toBeInTheDocument();
    expect(screen.getByText("1位")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "種類数ランキング" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Charlie")).toBeInTheDocument();
    expect(screen.getByText("1位")).toBeInTheDocument();
  });

  it("supports arrow, Home, and End keys with automatic tab activation", () => {
    renderDirectory();
    const startTab = screen.getByRole("tab", { name: "開始日時順" });

    startTab.focus();
    fireEvent.keyDown(startTab, { key: "ArrowRight" });
    const redemptionTab = screen.getByRole("tab", {
      name: "カード引き換え数ランキング",
    });
    expect(redemptionTab).toHaveFocus();
    expect(redemptionTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(redemptionTab, { key: "End" });
    const cardCountTab = screen.getByRole("tab", { name: "種類数ランキング" });
    expect(cardCountTab).toHaveFocus();
    expect(cardCountTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(cardCountTab, { key: "Home" });
    expect(startTab).toHaveFocus();
    expect(startTab).toHaveAttribute("aria-selected", "true");
  });

  it("keeps Twitch and collection anchors as siblings with secure external-link attributes", () => {
    const { container } = renderDirectory([entries[0]]);
    expect(container.querySelectorAll("a a")).toHaveLength(0);

    const twitchLink = screen.getByRole("link", {
      name: /Alphaの配信をTwitchで見る/,
    });
    const collectionLink = screen.getByRole("link", { name: "コレクションを見る" });
    expect(twitchLink).toHaveAttribute("href", "https://www.twitch.tv/alpha");
    expect(twitchLink).toHaveAttribute("target", "_blank");
    expect(twitchLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(twitchLink).not.toHaveAttribute("aria-label");
    expect(twitchLink).toHaveAccessibleName(/alpha stream/);
    expect(twitchLink.parentElement).toBe(collectionLink.parentElement?.parentElement);
    expect(screen.getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByAltText("Alphaのライブ配信サムネイル")).toBeInTheDocument();
  });

  it("shows both empty states and the listing CTA", () => {
    renderDirectory([], []);

    expect(
      screen.getByRole("heading", { name: "現在掲載中の配信はありません" }),
    ).toBeInTheDocument();
    const cta = screen.getByRole("link", {
      name: "配信者の方はこちらから掲載できます",
    });
    expect(cta).toHaveAttribute("href", "/dashboard/settings");

    fireEvent.click(screen.getByRole("tab", { name: "カード引き換え数ランキング" }));
    expect(screen.getByText("ランキングデータはありません")).toBeInTheDocument();
  });

  it("shows a stable elapsed duration based on the server-provided reference time", () => {
    renderDirectory([entries[0]]);

    const card = screen.getByRole("article");
    expect(within(card).getByText("配信開始から 1時間 30分")).toBeInTheDocument();
  });
});
