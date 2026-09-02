import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import LiveDirectory from "@/components/LiveDirectory";
import type {
  LiveDirectoryEntry,
  LiveDirectoryRankingEntry,
} from "@/lib/live-directory";
import jaMessages from "../../../messages/ja.json";

const normalLoginEntry: LiveDirectoryEntry = {
  streamerId: "normal-login-streamer",
  twitchUserId: "twitch-normal-login-streamer",
  twitchLogin: "normal-login-streamer",
  displayName: "Normal Login Streamer",
  profileImageUrl: "https://example.com/normal-login-streamer-profile.png",
  title: "normal login stream",
  gameName: "Game",
  viewerCount: 1,
  startedAt: "2026-08-11T02:00:00Z",
  thumbnailUrl: "https://example.com/normal-login-streamer-thumbnail.jpg",
};

const normalLoginRanking: LiveDirectoryRankingEntry = {
  identity: {
    twitchLogin: normalLoginEntry.twitchLogin,
    displayName: normalLoginEntry.displayName,
    profileImageUrl: normalLoginEntry.profileImageUrl,
  },
  cardCount: 1,
  redemptionCount: 1,
  totalPoints: 100,
  rankedMetrics: ["cardCount", "redemptionCount", "totalPoints"],
};

describe("live directory normal-login positive control (#1277)", () => {
  it("keeps the LIVE ring on the matching normal-login avatar", () => {
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <LiveDirectory
          entries={[normalLoginEntry]}
          rankings={{
            last7Days: [normalLoginRanking],
            allTime: [normalLoginRanking],
          }}
          referenceTime="2026-08-11T03:00:00Z"
        />
      </NextIntlClientProvider>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "チャネルポイントランキング" }));

    const normalRankingLink = screen.getByRole("link", {
      name: /Normal Login StreamerをTwitchで見る/,
    });
    const avatar = normalRankingLink.querySelector("img");

    expect(normalRankingLink).toHaveTextContent("LIVE");
    expect(normalRankingLink).toHaveTextContent("現在配信中");
    expect(normalRankingLink.querySelector(".ring-red-600")).toBe(avatar);
  });
});
