import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import TradeListedNotice from "@/components/TradeListedNotice";
import jaMessages from "../../../messages/ja.json";
import enMessages from "../../../messages/en.json";

const ja = jaMessages.trade;

function renderNotice(kind: "offer" | "auction", locale: "ja" | "en" = "ja") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "ja" ? jaMessages : enMessages}>
      <TradeListedNotice kind={kind} />
    </NextIntlClientProvider>,
  );
}

/**
 * #2080: the hub's post-listing notice.
 *
 * The unified form lands on /trade?listed=offer|auction instead of the old
 * board, so the hub must reproduce the board's notice (#1792 listedNotice /
 * #1791 auctionListedNotice) and strip the one-shot query parameter the same
 * way <TradeBoard>/<TradeAuctionBoard> do.
 */
describe("TradeListedNotice (#2080)", () => {
  it.each([
    ["offer", ja.listedNotice],
    ["auction", ja.auctionListedNotice],
  ] as const)("reuses the board's copy for a %s listing", (kind, text) => {
    renderNotice(kind);
    expect(screen.getByRole("status")).toHaveTextContent(text);
  });

  it("uses the same English copy as the boards", () => {
    renderNotice("auction", "en");
    expect(screen.getByRole("status")).toHaveTextContent(enMessages.trade.auctionListedNotice);
  });

  it.each(["offer", "auction"] as const)(
    "drops ?listed from the URL after showing the %s notice, keeping other params",
    (kind) => {
      window.history.replaceState(null, "", `/trade?listed=${kind}&sort=ending_soon`);

      renderNotice(kind);

      // replaceState (not a navigation/server render): the other query params
      // survive because only `listed` is removed, and the notice stays on
      // screen because nothing remounts the tree.
      expect(window.location.pathname).toBe("/trade");
      expect(window.location.search).toBe("?sort=ending_soon");
      expect(screen.getByRole("status")).toHaveTextContent(
        kind === "offer" ? ja.listedNotice : ja.auctionListedNotice,
      );
    },
  );
});
