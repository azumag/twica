import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import LiveDirectory from "@/components/LiveDirectory";
import type {
  LiveDirectoryEntry,
  LiveDirectoryRankingEntry,
} from "@/lib/live-directory";
import jaMessages from "../../../messages/ja.json";

const REFERENCE_TIME = "2026-08-11T03:00:00Z";

const emptyLoginEntry: LiveDirectoryEntry = {
  streamerId: "empty-login-streamer",
  twitchUserId: "twitch-empty-login-streamer",
  twitchLogin: "",
  displayName: "Empty Login Live",
  profileImageUrl: "",
  title: "Empty login stream",
  gameName: "Game",
  viewerCount: 1,
  startedAt: "2026-08-11T02:00:00Z",
  thumbnailUrl: "",
};

const emptyLoginRanking: LiveDirectoryRankingEntry = {
  identity: {
    twitchLogin: "",
    displayName: "Empty Login Ranking",
    profileImageUrl: "",
  },
  cardCount: 1,
  redemptionCount: 1,
  totalPoints: 100,
  rankedMetrics: ["cardCount", "redemptionCount", "totalPoints"],
};

describe("live indicator with an empty Twitch login (#1130)", () => {
  it("does not mark an empty ranking login live when the directory also contains an empty login", () => {
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <LiveDirectory
          entries={[emptyLoginEntry]}
          rankings={{
            last7Days: [emptyLoginRanking],
            allTime: [emptyLoginRanking],
          }}
          referenceTime={REFERENCE_TIME}
        />
      </NextIntlClientProvider>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "チャネルポイントランキング" }));

    const rankingLink = screen.getByRole("link", {
      name: /Empty Login RankingをTwitchで見る/,
    });
    expect(rankingLink).not.toHaveTextContent("LIVE");
    expect(rankingLink).not.toHaveTextContent("現在配信中");
    expect(rankingLink.querySelector(".ring-red-600")).toBeNull();
  });
});
