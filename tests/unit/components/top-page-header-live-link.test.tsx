import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TopPageHeader from "@/components/TopPageHeader";
import jaMessages from "../../../messages/ja.json";

vi.mock("@/components/LanguageSwitcher", () => ({
  LanguageSwitcherDark: () => <button type="button">language</button>,
}));

vi.mock("@/components/LogoutButton", () => ({
  LogoutButton: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

function renderHeader(initialSession: Parameters<typeof TopPageHeader>[0]["initialSession"]) {
  render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TopPageHeader initialSession={initialSession} />
    </NextIntlClientProvider>,
  );
}

describe("TopPageHeader live directory navigation", () => {
  it("shows /live to logged-out visitors", () => {
    renderHeader(null);

    expect(screen.getByRole("link", { name: "配信中" })).toHaveAttribute("href", "/live");
    expect(screen.getByRole("button", { name: "language" })).toBeInTheDocument();
  });

  it("keeps /live available beside the authenticated dashboard route", () => {
    renderHeader({
      twitchUserId: "user-1",
      twitchUsername: "alpha",
      twitchDisplayName: "Alpha",
      twitchProfileImageUrl: "https://example.com/alpha.png",
      broadcasterType: "affiliate",
    });

    expect(screen.getByRole("link", { name: "配信中" })).toHaveAttribute("href", "/live");
    expect(screen.getByRole("link", { name: "ダッシュボード" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });
});
