import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import DashboardNav from "@/components/DashboardNav";
import DashboardShell from "@/components/DashboardShell";
import jaMessages from "../../../messages/ja.json";

// `usePathname` is mutable per test so the route-change behaviour (drawer closes
// on navigation) can be exercised without a real Next.js router.
const router = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => router.pathname,
}));

function renderShell({
  isStreamer = true,
  isSupporter = true,
}: {
  isStreamer?: boolean;
  isSupporter?: boolean;
} = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <DashboardShell
        nav={<DashboardNav isStreamer={isStreamer} isSupporter={isSupporter} />}
      >
        <main>page content</main>
      </DashboardShell>
    </NextIntlClientProvider>,
  );
}

function sidebarLinks() {
  const nav = screen.getByRole("navigation", {
    name: jaMessages.navigation.sidebarLabel,
  });
  return within(nav).getAllByRole("link");
}

describe("DashboardShell sidebar", () => {
  beforeEach(() => {
    router.pathname = "/dashboard";
  });

  it("renders a single navigation landmark instead of desktop/mobile duplicates", () => {
    renderShell();

    // The old DashboardNav rendered the same links twice (md:flex + md:hidden),
    // so `getByRole("link")` matched two elements. The shell must render the nav
    // once and rely on CSS for the responsive layout.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(
      screen.getAllByRole("link", { name: jaMessages.navigation.live }),
    ).toHaveLength(1);
    expect(sidebarLinks().map((link) => link.getAttribute("href"))).toEqual([
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

  it("keeps the sidebar/drawer breakpoint at lg so md content grids keep their width", () => {
    const { container } = renderShell();

    // レビュー指摘: md（768px）からサイドバーを出すと、本文が約736pxから
    // 約488pxへ縮み、本文側の md: 段組みが画面幅で発火したまま列だけ細くなる。
    // shell 側の切り替えが lg に揃っていることを DOM の class で固定する。
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("lg:flex", "lg:gap-6");

    const trigger = screen.getByRole("button", {
      name: jaMessages.navigation.menu,
    });
    expect(trigger).toHaveClass("lg:hidden");

    const panel = document.getElementById(
      trigger.getAttribute("aria-controls") ?? "",
    );
    expect(panel).toHaveClass("hidden", "lg:block", "lg:w-56");

    // lg 以上では出さない閉じるボタンの行も同じ閾値であること。
    expect(
      screen.getByRole("button", { name: jaMessages.navigation.closeMenu })
        .parentElement,
    ).toHaveClass("lg:hidden");

    fireEvent.click(trigger);
    expect(panel).toHaveClass("lg:static", "lg:w-56");
    expect(screen.getByTestId("dashboard-shell-backdrop")).toHaveClass(
      "lg:hidden",
    );

    // md: が1つでも残ると 768〜1023px でサイドバーが出てしまうため、
    // shell が描画する要素の class に md: がないことも確認する。
    const shellClasses = [
      root.className,
      trigger.className,
      panel?.className ?? "",
      screen.getByTestId("dashboard-shell-backdrop").className,
    ].join(" ");
    expect(shellClasses).not.toMatch(/(^|\s)md:/);
  });

  it("keeps the streamerOnly and supporterOnly visibility rules", () => {
    const cases = [
      {
        isStreamer: false,
        isSupporter: false,
        expected: ["/dashboard", "/dashboard/history", "/dashboard/collection", "/live"],
      },
      {
        isStreamer: false,
        isSupporter: true,
        expected: [
          "/dashboard",
          "/dashboard/history",
          "/dashboard/collection",
          "/dashboard/inquiries",
          "/live",
        ],
      },
      {
        isStreamer: true,
        isSupporter: false,
        expected: [
          "/dashboard",
          "/dashboard/cards",
          "/dashboard/settings",
          "/dashboard/history",
          "/dashboard/stats",
          "/dashboard/collection",
          "/live",
        ],
      },
    ] as const;

    for (const { isStreamer, isSupporter, expected } of cases) {
      const { unmount } = renderShell({ isStreamer, isSupporter });
      expect(sidebarLinks().map((link) => link.getAttribute("href"))).toEqual(
        expected,
      );
      unmount();
    }
  });

  it("marks only the current route with aria-current=page", () => {
    router.pathname = "/dashboard/collection/streamer-1";
    renderShell();

    const links = sidebarLinks();
    const active = links.filter(
      (link) => link.getAttribute("aria-current") === "page",
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAttribute("href", "/dashboard/collection");
    expect(
      links.find((link) => link.getAttribute("href") === "/dashboard"),
    ).not.toHaveAttribute("aria-current");
  });

  it("treats /dashboard as an exact match while other items use their prefix", () => {
    router.pathname = "/dashboard/history";
    renderShell();

    const links = sidebarLinks();
    const current = links
      .filter((link) => link.getAttribute("aria-current") === "page")
      .map((link) => link.getAttribute("href"));
    expect(current).toEqual(["/dashboard/history"]);
  });

  it("toggles aria-expanded / the drawer and returns focus to the trigger", () => {
    renderShell();

    const trigger = screen.getByRole("button", {
      name: jaMessages.navigation.menu,
    });
    const panel = document.getElementById(
      trigger.getAttribute("aria-controls") ?? "",
    );

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveAttribute("data-state", "closed");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveAttribute("data-state", "open");

    // The visible close control inside the drawer also closes it and restores
    // focus to the menu trigger (the element that opened the drawer).
    fireEvent.click(
      screen.getByRole("button", { name: jaMessages.navigation.closeMenu }),
    );
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveAttribute("data-state", "closed");
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger", () => {
    renderShell();

    const trigger = screen.getByRole("button", {
      name: jaMessages.navigation.menu,
    });
    fireEvent.click(trigger);

    const firstLink = screen.getByRole("link", {
      name: jaMessages.navigation.overview,
    });
    firstLink.focus();
    expect(firstLink).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when a navigation item is clicked", () => {
    renderShell();

    const trigger = screen.getByRole("button", {
      name: jaMessages.navigation.menu,
    });
    fireEvent.click(trigger);

    const link = screen.getByRole("link", {
      name: jaMessages.navigation.collection,
    });
    // Keep happy-dom from navigating away from the test page; React's handler
    // still receives the click.
    link.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    fireEvent.click(link);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when the backdrop is clicked", () => {
    renderShell();

    const trigger = screen.getByRole("button", {
      name: jaMessages.navigation.menu,
    });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("dashboard-shell-backdrop"));

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when the route changes", () => {
    const { rerender } = renderShell({
      isStreamer: true,
      isSupporter: true,
    });

    const trigger = screen.getByRole("button", {
      name: jaMessages.navigation.menu,
    });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    router.pathname = "/dashboard/cards";
    rerender(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <DashboardShell nav={<DashboardNav isStreamer isSupporter />}>
          <main>page content</main>
        </DashboardShell>
      </NextIntlClientProvider>,
    );

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
