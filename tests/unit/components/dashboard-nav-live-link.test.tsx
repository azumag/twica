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
  it("places /live after inquiries on desktop and mobile", () => {
    renderNav(true, true);
    const links = within(screen.getByRole("navigation")).getAllByRole("link");
    const hrefs = links.map((link) => link.getAttribute("href"));
    const half = hrefs.length / 2;

    expect(hrefs.slice(half - 2, half)).toEqual([
      "/dashboard/inquiries",
      "/live",
    ]);
    expect(hrefs.slice(-2)).toEqual([
      "/dashboard/inquiries",
      "/live",
    ]);
  });

  it("keeps the public /live route available to non-streamer users", () => {
    renderNav(false);

    expect(
      screen.getAllByRole("link", { name: "公開チャネル" }),
    ).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "カード管理" })).not.toBeInTheDocument();
  });
});
