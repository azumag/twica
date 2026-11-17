import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import DashboardNav from "@/components/DashboardNav";
import jaMessages from "../../../messages/ja.json";

// `usePathname` はテストごとに変える。トレード配下の prefix 判定を
// 実ルーターなしで確かめるため、固定値ではなく mutable な値にしている。
const router = vi.hoisted(() => ({ pathname: "/dashboard" }));

vi.mock("next/navigation", () => ({
  usePathname: () => router.pathname,
}));

// #2078: サイドバーの「トレード」は CARD_TRADE_UI_VISIBLE が true の間だけ出す。
// 定数はモジュール評価時に固定されるため、getter 経由の mutable な値にして
// 1つのテストファイルで true / false の両方を検証できるようにする。
const flags = vi.hoisted(() => ({ cardTradeUiVisible: true }));

vi.mock("@/lib/constants", () => ({
  get CARD_TRADE_UI_VISIBLE() {
    return flags.cardTradeUiVisible;
  },
}));

const tradeLabel = jaMessages.navigation.trade;

function renderNav(isStreamer: boolean, isSupporter = false) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <DashboardNav isStreamer={isStreamer} isSupporter={isSupporter} />
    </NextIntlClientProvider>,
  );
}

function sidebarLinks() {
  // The sidebar is rendered once (responsive switching lives in DashboardShell),
  // so read the links from the single navigation landmark instead of splitting
  // a duplicated desktop/mobile list in half.
  return within(
    screen.getByRole("navigation", {
      name: jaMessages.navigation.sidebarLabel,
    }),
  ).getAllByRole("link");
}

function sidebarHrefs() {
  return sidebarLinks().map((link) => link.getAttribute("href"));
}

beforeEach(() => {
  router.pathname = "/dashboard";
  flags.cardTradeUiVisible = true;
});

describe("DashboardNav trade link (#2078)", () => {
  it("places /live last and /trade directly after my collection", () => {
    renderNav(true, true);
    // #2078: 「トレード」は「マイコレクション」の直後へ入り、/live は
    // 最後の補助導線のままという並びを固定する。
    expect(sidebarHrefs()).toEqual([
      "/dashboard",
      "/dashboard/cards",
      "/dashboard/settings",
      "/dashboard/history",
      "/dashboard/stats",
      "/dashboard/collection",
      "/trade",
      "/dashboard/inquiries",
      "/live",
    ]);
  });

  it("hides the trade link while CARD_TRADE_UI_VISIBLE is false", () => {
    flags.cardTradeUiVisible = false;
    renderNav(true, true);

    expect(screen.queryByRole("link", { name: tradeLabel })).not.toBeInTheDocument();
    const hrefs = sidebarHrefs();
    expect(hrefs).not.toContain("/trade");
    // トレード項目が消えても /live は最後のまま。
    expect(hrefs.at(-1)).toBe("/live");
  });

  it("shows the trade link to non-streamers while the flag is true", () => {
    // 視聴者も使う機能なので streamerOnly を付けない (#2078)。
    renderNav(false, false);

    expect(screen.getByRole("link", { name: tradeLabel })).toHaveAttribute("href", "/trade");
  });

  it("marks only the trade link current on /trade routes", () => {
    for (const pathname of ["/trade", "/trade/streamer-1", "/trade/mine"]) {
      router.pathname = pathname;
      const { unmount } = renderNav(true, true);

      expect(screen.getByRole("link", { name: tradeLabel })).toHaveAttribute(
        "aria-current",
        "page",
      );
      // /trade 配下では「マイコレクション」を点灯させない。
      expect(
        screen.getByRole("link", { name: jaMessages.navigation.collection }),
      ).not.toHaveAttribute("aria-current");

      unmount();
    }
  });

  it("keeps the /collection/* special case on my collection, not trade", () => {
    router.pathname = "/collection/streamer-1";
    renderNav(true, true);

    expect(
      screen.getByRole("link", { name: jaMessages.navigation.collection }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: tradeLabel })).not.toHaveAttribute(
      "aria-current",
    );
  });
});

describe("DashboardNav live directory link", () => {
  it("keeps the public /live route available to non-streamer users", () => {
    renderNav(false);

    expect(
      screen.getAllByRole("link", { name: "公開チャネル" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "カード管理" })).not.toBeInTheDocument();
  });
});
