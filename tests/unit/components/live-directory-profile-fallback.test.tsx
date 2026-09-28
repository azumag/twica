import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import LiveDirectory from "@/components/LiveDirectory";
import type {
  LiveDirectoryEntry,
  LiveDirectoryRankingEntry,
} from "@/lib/live-directory";
import jaMessages from "../../../messages/ja.json";

const REFERENCE_TIME = "2026-08-11T03:00:00Z";

function renderDirectory(
  entries: LiveDirectoryEntry[],
  rankings: LiveDirectoryRankingEntry[] = [],
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <LiveDirectory
        entries={entries}
        rankings={{ last7Days: rankings, allTime: rankings }}
        referenceTime={REFERENCE_TIME}
      />
    </NextIntlClientProvider>,
  );
}

describe("LiveDirectory profile fallback", () => {
  it("keeps a non-BMP first character intact in a stream card fallback", () => {
    const entry: LiveDirectoryEntry = {
      streamerId: "emoji-streamer",
      twitchUserId: "twitch-emoji-streamer",
      twitchLogin: "emoji-streamer",
      displayName: "😀Alice",
      profileImageUrl: "",
      title: "Emoji stream",
      gameName: "Game",
      viewerCount: 1,
      startedAt: "2026-08-11T02:00:00Z",
      thumbnailUrl: "",
    };

    renderDirectory([entry]);

    expect(screen.getByText("😀", { exact: true })).toBeInTheDocument();
  });

  it("keeps a non-BMP first character intact in a ranking fallback", () => {
    const ranking: LiveDirectoryRankingEntry = {
      identity: {
        twitchLogin: "emoji-ranker",
        displayName: "😀Ranker",
        profileImageUrl: "",
      },
      cardCount: 1,
      redemptionCount: 2,
      totalPoints: 3,
      rankedMetrics: ["cardCount", "redemptionCount", "totalPoints"],
    };

    renderDirectory([], [ranking]);
    fireEvent.click(screen.getByRole("tab", { name: "カード引き換え数ランキング" }));

    expect(screen.getByText("😀", { exact: true })).toBeInTheDocument();
  });
});
