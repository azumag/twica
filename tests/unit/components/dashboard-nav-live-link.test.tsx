import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import DashboardNav from "@/components/DashboardNav";
import jaMessages from "../../../messages/ja.json";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

function renderNav(isStreamer: boolean, isSupporter = false) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <DashboardNav isStreamer={isStreamer} isSupporter={isSupporter} />
    </NextIntlClientProvider>,
  );
}

describe("DashboardNav live directory link", () => {
  it("places /live after inquiries in the sidebar", () => {
    renderNav(true, true);
    // The sidebar is rendered once (responsive switching lives in DashboardShell),
    // so read the links from the single navigation landmark instead of splitting
    // a duplicated desktop/mobile list in half.
    const links = within(
      screen.getByRole("navigation", {
        name: jaMessages.navigation.sidebarLabel,
      }),
    ).getAllByRole("link");
    const hrefs = links.map((link) => link.getAttribute("href"));

    expect(hrefs).toEqual([
      "/dashboard",
      "/dashboard/cards",
      "/dashboard/settings",
      "/dashboard/history",
      "/dashboard/stats",
      "/dashboard/collection",
      "/dashboard/inquiries",
      "/live",
    ]);
  });

  it("keeps the public /live route available to non-streamer users", () => {
    renderNav(false);

    expect(
      screen.getAllByRole("link", { name: "公開チャネル" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "カード管理" })).not.toBeInTheDocument();
  });
});
