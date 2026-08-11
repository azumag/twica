import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import DashboardNav from "@/components/DashboardNav";
import jaMessages from "../../../messages/ja.json";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

function renderNav(isStreamer: boolean) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <DashboardNav isStreamer={isStreamer} isSupporter={false} />
    </NextIntlClientProvider>,
  );
}

describe("DashboardNav live directory link", () => {
  it("places /live between overview and card management on desktop and mobile", () => {
    renderNav(true);
    const links = within(screen.getByRole("navigation")).getAllByRole("link");
    const hrefs = links.map((link) => link.getAttribute("href"));
    const half = hrefs.length / 2;

    expect(hrefs.slice(0, 3)).toEqual([
      "/dashboard",
      "/live",
      "/dashboard/cards",
    ]);
    expect(hrefs.slice(half, half + 3)).toEqual([
      "/dashboard",
      "/live",
      "/dashboard/cards",
    ]);
  });

  it("keeps the public /live route available to non-streamer users", () => {
    renderNav(false);

    expect(
      screen.getAllByRole("link", { name: "チャネル・ランキング" }),
    ).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "カード管理" })).not.toBeInTheDocument();
  });
});
