import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import LiveDirectory from "@/components/LiveDirectory";
import type { LiveDirectoryEntry } from "@/lib/live-directory";
import enMessages from "../../../messages/en.json";
import jaMessages from "../../../messages/ja.json";

const REFERENCE_TIME = "2026-08-11T03:00:00Z";

function entry(startedAt: string): LiveDirectoryEntry {
  return {
    streamerId: "duration-test",
    twitchUserId: "twitch-duration-test",
    twitchLogin: "duration-test",
    displayName: "Duration Test",
    profileImageUrl: "",
    title: "Duration test stream",
    gameName: "Game",
    viewerCount: 1,
    startedAt,
    thumbnailUrl: "",
  };
}

function renderDirectory(
  locale: "ja" | "en",
  startedAt: string,
) {
  const messages = locale === "ja" ? jaMessages : enMessages;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <LiveDirectory
        entries={[entry(startedAt)]}
        rankings={{ last7Days: [], allTime: [] }}
        referenceTime={REFERENCE_TIME}
      />
    </NextIntlClientProvider>,
  );
}

describe("LiveDirectory duration formatting", () => {
  it("renders the just-started and unknown Japanese boundary values", () => {
    const { rerender } = renderDirectory("ja", REFERENCE_TIME);
    expect(screen.getByText(/開始したばかり/)).toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <LiveDirectory
          entries={[entry("not-a-date")]}
          rankings={{ last7Days: [], allTime: [] }}
          referenceTime={REFERENCE_TIME}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/開始時刻不明/)).toBeInTheDocument();
  });

  it("renders an exact-hour Japanese duration without a trailing zero-minute segment", () => {
    renderDirectory("ja", "2026-08-11T01:00:00Z");

    expect(screen.getByText(/2時間/)).toBeInTheDocument();
    expect(screen.queryByText(/2時間 0分/)).not.toBeInTheDocument();
  });

  it("uses English plural forms for hours and minutes", () => {
    renderDirectory("en", "2026-08-11T00:58:00Z");

    expect(screen.getByText(/2 hrs 2 mins/)).toBeInTheDocument();
  });
});
