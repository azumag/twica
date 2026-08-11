import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import LiveDirectory, {
  sortLiveDirectoryEntries,
  type LiveDirectorySort,
} from "@/components/LiveDirectory";
import type { LiveDirectoryEntry } from "@/lib/live-directory";
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
    stats: { cardCount: 0, redemptionCount: 0 },
    ...overrides,
  };
}

const entries = [
  entry("alpha", {
    displayName: "Alpha",
    viewerCount: 20,
    startedAt: "2026-08-11T01:30:00Z",
    stats: { cardCount: 4, redemptionCount: 90 },
  }),
  entry("bravo", {
    displayName: "Bravo",
    viewerCount: 50,
    startedAt: "2026-08-11T02:30:00Z",
    stats: null,
  }),
  entry("charlie", {
    displayName: "Charlie",
    viewerCount: 10,
    startedAt: "2026-08-11T02:00:00Z",
    stats: { cardCount: 12, redemptionCount: 30 },
  }),
];

function idsFor(sort: LiveDirectorySort): string[] {
  return sortLiveDirectoryEntries(entries, sort).map((item) => item.streamerId);
}

function renderDirectory(items: LiveDirectoryEntry[] = entries) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <LiveDirectory entries={items} referenceTime={REFERENCE_TIME} />
    </NextIntlClientProvider>,
  );
}

function renderedCardIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("article[data-streamer-id]")].map(
    (card) => card.getAttribute("data-streamer-id") ?? "",
  );
}

describe("sortLiveDirectoryEntries", () => {
  it("sorts all three modes and keeps stats=null last for statistical modes", () => {
    expect(idsFor("recentlyStarted")).toEqual(["bravo", "charlie", "alpha"]);
    expect(idsFor("cardCount")).toEqual(["charlie", "alpha", "bravo"]);
    expect(idsFor("redemptionCount")).toEqual(["alpha", "charlie", "bravo"]);
  });

  it("does not mutate the entries prop and distinguishes public zero from private stats", () => {
    const publicZero = entry("public-zero", {
      viewerCount: 1,
      stats: { cardCount: 0, redemptionCount: 0 },
    });
    const privateHighViewers = entry("private", {
      viewerCount: 999,
      stats: null,
    });
    const input = [privateHighViewers, publicZero];
    const snapshot = [...input];

    expect(sortLiveDirectoryEntries(input, "cardCount").map((item) => item.streamerId)).toEqual([
      "public-zero",
      "private",
    ]);
    expect(input).toEqual(snapshot);
  });

  it("places invalid startedAt values last without returning an unstable NaN comparator", () => {
    const invalid = entry("invalid", { startedAt: "not-a-date", viewerCount: 100 });
    const valid = entry("valid", { startedAt: "2026-08-11T02:00:00Z", viewerCount: 1 });

    expect(
      sortLiveDirectoryEntries([invalid, valid], "recentlyStarted").map(
        (item) => item.streamerId,
      ),
    ).toEqual(["valid", "invalid"]);
  });

  it("does not use viewer count as a hidden tie-breaker", () => {
    const alpha = entry("alpha", { displayName: "Alpha", viewerCount: 1 });
    const bravo = entry("bravo", { displayName: "Bravo", viewerCount: 999 });

    expect(
      sortLiveDirectoryEntries([bravo, alpha], "recentlyStarted").map(
        (item) => item.streamerId,
      ),
    ).toEqual(["alpha", "bravo"]);
  });
});

describe("LiveDirectory", () => {
  it("uses recently-started order initially and omits viewer-count sorting", () => {
    const { container } = renderDirectory();
    expect(renderedCardIds(container)).toEqual(["bravo", "charlie", "alpha"]);

    const sortSelect = screen.getByRole("combobox", { name: "並び順" });
    expect(sortSelect).toHaveValue("recentlyStarted");
    expect(screen.queryByRole("option", { name: "視聴者数" })).not.toBeInTheDocument();

    fireEvent.change(sortSelect, {
      target: { value: "cardCount" },
    });
    expect(renderedCardIds(container)).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("renders public stats and explicitly identifies private stats", () => {
    renderDirectory();

    expect(screen.getByText("統計非公開")).toBeInTheDocument();
    expect(screen.getAllByText("カード種類数").length).toBeGreaterThan(0);
    expect(screen.getAllByText("チャネルポイント引換数").length).toBeGreaterThan(0);
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

  it("shows the empty state and listing CTA even when no streams are live", () => {
    renderDirectory([]);

    expect(screen.getByRole("heading", { name: "現在掲載中の配信はありません" })).toBeInTheDocument();
    const cta = screen.getByRole("link", {
      name: "配信者の方はこちらから掲載できます",
    });
    expect(cta).toHaveAttribute("href", "/dashboard/settings");
  });

  it("shows a stable elapsed duration based on the server-provided reference time", () => {
    renderDirectory([entries[0]]);

    const card = screen.getByRole("article");
    expect(within(card).getByText("配信開始から 1時間 30分")).toBeInTheDocument();
  });
});
