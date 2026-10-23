import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * /guide/trade renders from the real ja/en message catalogs.
 *
 * getTranslations is mocked with a resolver over the actual messages/*.json that THROWS
 * on a missing key. next-intl itself would only log the error and print the key path,
 * so a key missing from one locale would otherwise show up as a raw "tradeGuidePage.x.y"
 * string in production without failing any test. The resolver also fills simple
 * `{name}` placeholders, because the page passes the server's limits in that way
 * (the numbers are the code constants, not text typed into the messages).
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  locale: { current: "ja" as "ja" | "en" },
}));

vi.mock("@/lib/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/components/PublicFooter", () => ({ default: () => <footer data-testid="public-footer" /> }));
vi.mock("next-intl/server", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const catalogs = {
    ja: JSON.parse(readFileSync(join(process.cwd(), "messages/ja.json"), "utf8")),
    en: JSON.parse(readFileSync(join(process.cwd(), "messages/en.json"), "utf8")),
  } as Record<string, Record<string, unknown>>;
  return {
    getTranslations: async (namespace: string) => (key: string, values?: Record<string, string | number>) => {
      let value: unknown = catalogs[mocks.locale.current];
      for (const part of `${namespace}.${key}`.split(".")) {
        value = (value as Record<string, unknown> | undefined)?.[part];
      }
      if (typeof value !== "string") {
        throw new Error(`MISSING_MESSAGE(${mocks.locale.current}): ${namespace}.${key}`);
      }
      return value.replace(/\{(\w+)\}/g, (_placeholder, name: string) => {
        if (!values || !(name in values)) {
          // A placeholder without a value would print "{max}" on screen.
          throw new Error(`MISSING_VALUE(${mocks.locale.current}): ${namespace}.${key} needs {${name}}`);
        }
        return String(values[name]);
      });
    },
  };
});

import TradeGuidePage, { metadata } from "@/app/guide/trade/page";
import { TRADE_MAX_OPEN_OFFERS, TRADE_MAX_WANTED_QUANTITY } from "@/lib/trade";
import {
  EXAMPLE_ACCEPT_GET,
  EXAMPLE_ACCEPT_GIVE,
  EXAMPLE_AUCTION_BIDS,
  EXAMPLE_AUCTION_DURATION_HOURS,
  EXAMPLE_OFFER_GIVE,
  EXAMPLE_OFFER_WANT,
} from "@/components/trade-guide/exampleQuantities";
import {
  TRADE_AUCTION_DURATIONS_HOURS,
  TRADE_AUCTION_SELECTION_HOURS,
  TRADE_MAX_ACTIVE_BIDS,
  TRADE_MAX_BID_QUANTITY,
} from "@/lib/trade-auction";

function readMessages(locale: "ja" | "en") {
  return JSON.parse(readFileSync(join(process.cwd(), `messages/${locale}.json`), "utf8"));
}

/** Every leaf string of the tradeGuidePage namespace with its dotted path. */
function leaves(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Regex that matches a message whose `{placeholders}` have been filled with anything. */
function messagePattern(message: string): RegExp {
  const escaped = message.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\{\w+\}/g, "[^]+?"));
}

function fill(message: string, values: Record<string, string | number>) {
  return message.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.locale.current = "ja";
  mocks.getSession.mockResolvedValue(null);
});

describe.each(["ja", "en"] as const)("/guide/trade (%s)", (locale) => {
  beforeEach(() => {
    mocks.locale.current = locale;
  });

  it("renders for anonymous visitors with the title, every section (viewers first, streamers last) and the footer", async () => {
    const page = readMessages(locale).tradeGuidePage;
    const { container } = render(await TradeGuidePage());

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(page.title);
    const ids = ["choose", "start", "accept", "offer", "auction", "faq", "streamer"] as const;
    for (const id of ids) {
      const heading = screen.getByRole("heading", { level: 2, name: page[id].title });
      expect(heading.closest("section")).toHaveAttribute("id", id);
    }
    // Page order: what to do first (A, B, C), then trouble-shooting, then the streamer part last.
    expect([...container.querySelectorAll("main > section")].map((section) => section.id)).toEqual([...ids]);
    expect(screen.getByTestId("public-footer")).toBeInTheDocument();
    // 未ログインでも閲覧でき、ホームへ戻れる（/guide と同じヘッダー）
    expect(screen.getByRole("link", { name: readMessages(locale).guidePage.home })).toHaveAttribute("href", "/");
  });

  it("renders every message of the namespace (no orphan copy, no raw key paths)", async () => {
    const page = readMessages(locale).tradeGuidePage;
    const { container } = render(await TradeGuidePage());
    // Visible text plus aria-labels: a few strings (tabsLabel / termsLabel) are accessible names.
    const labels = [...container.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label"));
    const everything = `${container.textContent ?? ""}\n${labels.join("\n")}`;

    // metaDescription / entryLink are consumed by the metadata and the trade layout,
    // durationSeparator is folded into the "24h / 3d / 7d" chip text.
    const elsewhere = new Set(["metaDescription", "entryLink", "auction.durationSeparator"]);
    for (const [path, message] of leaves(page)) {
      if (elsewhere.has(path)) continue;
      expect(everything, `${locale}: ${path}`).toMatch(messagePattern(message));
    }
    expect(everything).not.toContain("tradeGuidePage.");
    expect(everything).not.toMatch(/\{\w+\}/); // an unfilled placeholder
  });

  it("states every limit with the number the server enforces", async () => {
    const { container } = render(await TradeGuidePage());
    const text = container.textContent ?? "";
    const messages = readMessages(locale);
    const trade = messages.trade;
    const page = messages.tradeGuidePage;
    const durationLabels = [trade.createAuctionDuration24h, trade.createAuctionDuration3d, trade.createAuctionDuration7d];
    const durations = durationLabels.join(page.auction.durationSeparator);
    const hours = TRADE_AUCTION_SELECTION_HOURS;

    // The labels are looked up per hour value; make sure the lookup covers the constant.
    expect([...TRADE_AUCTION_DURATIONS_HOURS]).toEqual([24, 72, 168]);

    expect(text).toContain(fill(page.offer.steps.want.description, { max: TRADE_MAX_WANTED_QUANTITY }));
    expect(text).toContain(fill(page.offer.rules.limit, { max: TRADE_MAX_OPEN_OFFERS }));
    expect(text).toContain(fill(page.auction.seller.create.description, { durations }));
    expect(text).toContain(fill(page.auction.seller.select.description, { hours }));
    expect(text).toContain(fill(page.auction.seller.note, { hours }));
    expect(text).toContain(fill(page.auction.timeline.maxHours, { hours }));
    expect(text).toContain(fill(page.auction.timeline.expired, { hours }));
    expect(text).toContain(fill(page.auction.bidder.bid.description, { max: TRADE_MAX_BID_QUANTITY }));
    expect(text).toContain(fill(page.auction.rules.activeBids, { max: TRADE_MAX_ACTIVE_BIDS }));
    expect(text).toContain(
      fill(page.faq.limitReached.reason, { maxListings: TRADE_MAX_OPEN_OFFERS, maxBids: TRADE_MAX_ACTIVE_BIDS }),
    );
    expect(text).toContain(fill(page.faq.selectionExpired.reason, { hours }));
  });

  it("keeps the worked examples inside what the server accepts", () => {
    // The examples are illustrations, not rules, but an example that the app would refuse
    // ("want 11 copies") would teach the wrong thing.
    expect([...TRADE_AUCTION_DURATIONS_HOURS]).toContain(EXAMPLE_AUCTION_DURATION_HOURS);
    // A listing always gives exactly one card; the wanted side is 1..max copies.
    expect(EXAMPLE_OFFER_GIVE).toBe(1);
    expect(EXAMPLE_ACCEPT_GET).toBe(1);
    for (const wanted of [EXAMPLE_OFFER_WANT, EXAMPLE_ACCEPT_GIVE]) {
      expect(wanted).toBeGreaterThanOrEqual(1);
      expect(wanted).toBeLessThanOrEqual(TRADE_MAX_WANTED_QUANTITY);
    }
    // Bids: 1..max copies of one kind of card each, and exactly one is picked.
    for (const bid of EXAMPLE_AUCTION_BIDS) {
      expect(bid.quantity).toBeGreaterThanOrEqual(1);
      expect(bid.quantity).toBeLessThanOrEqual(TRADE_MAX_BID_QUANTITY);
    }
    expect(EXAMPLE_AUCTION_BIDS.filter((bid) => bid.picked)).toHaveLength(1);
    expect(EXAMPLE_AUCTION_BIDS.length).toBeLessThanOrEqual(TRADE_MAX_ACTIVE_BIDS);
  });

  it("draws the example quantities into the figures (badge = the number in the caption)", async () => {
    const { container } = render(await TradeGuidePage());
    const badges = (selector: string) =>
      [...container.querySelectorAll(`${selector} figure span.-top-2`)].map((el) => el.textContent);
    expect(badges("section#accept")).toEqual([`×${EXAMPLE_ACCEPT_GIVE}`, `×${EXAMPLE_ACCEPT_GET}`]);
    expect(badges("section#offer").slice(0, 2)).toEqual([`×${EXAMPLE_OFFER_GIVE}`, `×${EXAMPLE_OFFER_WANT}`]);
    // the lit duration of the timeline is the example's
    const lit = container.querySelector("section#auction figure ul li.bg-emerald-500")!.textContent;
    const trade = readMessages(locale).trade;
    expect(lit).toBe(trade[{ 24: "createAuctionDuration24h", 72: "createAuctionDuration3d", 168: "createAuctionDuration7d" }[EXAMPLE_AUCTION_DURATION_HOURS]!]);
  });

  it("shows the real screen labels in the diagrams (status chips, tabs, settings, card edit)", async () => {
    const messages = readMessages(locale);
    const { container } = render(await TradeGuidePage());
    const text = container.textContent ?? "";
    const expected = [
      // auction status chips: exactly the board's wording
      messages.trade.auctionPhaseBidding,
      messages.trade.auctionPhaseSelecting,
      messages.trade.auctionPhaseCompleted,
      messages.trade.auctionPhaseExpired,
      messages.trade.auctionPhaseCancelled,
      messages.trade.auctionBidUnsettleableBadge,
      // board chrome and the buttons the steps name
      messages.trade.collectionTradeButton,
      messages.trade.tabInChannel,
      messages.trade.tabCrossChannel,
      messages.trade.tabAuction,
      messages.trade.myTradesLink,
      // settings panel mock
      messages.tradeSettings.title,
      messages.tradeSettings.form.tradeEnabled,
      messages.tradeSettings.form.crossChannelEnabled,
      messages.tradeSettings.form.requiresTradeEnabled,
      messages.tradeSettings.status.enabled,
      messages.tradeSettings.status.disabled,
      // card edit checkbox + breadcrumbs
      messages.cardManager.form.tradeWantable,
      messages.cardManager.editCard,
      messages.navigation.cardManagement,
      messages.header.userSettings,
      messages.accountPage.collectionSharing.title,
      messages.cardVisibilitySettings.title,
    ];
    for (const label of expected) {
      expect(text, `${locale}: ${label}`).toContain(label);
    }
  });

  it("keeps the heading outline unbroken (one h1, no skipped levels)", async () => {
    const { container } = render(await TradeGuidePage());
    const levels = [...container.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] - levels[i - 1], `heading #${i}`).toBeLessThanOrEqual(1);
    }
  });

  it("explains every diagram in words (figure + figcaption) and hides decorative SVG", async () => {
    const page = readMessages(locale).tradeGuidePage;
    const { container } = render(await TradeGuidePage());

    // Diagrams that carry meaning are <figure>s with a caption: the two exchange examples,
    // cross-channel, auction timeline and the two settings panels.
    const figures = [...container.querySelectorAll("figure")];
    expect(figures.length).toBeGreaterThanOrEqual(6);
    for (const figure of figures) {
      const caption = figure.querySelector("figcaption");
      expect(caption, figure.className).not.toBeNull();
      expect((caption!.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
    expect(container.querySelector("section#accept figure figcaption")!.textContent).toBe(
      fill(page.accept.example.caption, { give: EXAMPLE_ACCEPT_GIVE, get: EXAMPLE_ACCEPT_GET }),
    );
    expect(container.querySelector("section#offer figure figcaption")!.textContent).toBe(
      fill(page.offer.example.caption, { give: EXAMPLE_OFFER_GIVE, want: EXAMPLE_OFFER_WANT }),
    );
    expect(container.querySelector("section#auction figure figcaption")!.textContent).toBe(
      page.auction.timeline.caption,
    );

    // Every SVG is decorative: text next to it says the same thing. It is hidden either
    // on the <svg> itself or by a wrapper (the card placeholder hides its whole tile).
    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs.length).toBeGreaterThan(30);
    for (const svg of svgs) {
      expect(svg.closest('[aria-hidden="true"]'), svg.outerHTML.slice(0, 80)).not.toBeNull();
    }
    // The ON/OFF state of a mock switch is text, not only the switch colour.
    const settings = container.querySelector("section#streamer")!.textContent ?? "";
    expect(settings).toContain(page.streamer.enable.stateOn);
    expect(settings).toContain(page.streamer.enable.stateOff);
  });

  it("builds the flows as real ordered lists numbered from the array order", async () => {
    const { container } = render(await TradeGuidePage());
    const numberOf = (list: Element) =>
      [...list.children].map((li) => li.querySelector("span.rounded-full")?.textContent);
    expect(numberOf(container.querySelector("section#accept ol")!)).toEqual(["1", "2", "3"]);
    expect(numberOf(container.querySelector("section#offer ol")!)).toEqual(["1", "2", "3"]);
    // auction: [0] is the timeline (no number badges), then the seller and bidder flows
    const auctionLists = [...container.querySelectorAll("section#auction ol")];
    expect(auctionLists).toHaveLength(3);
    expect(auctionLists[0].children).toHaveLength(4);
    expect(numberOf(auctionLists[1])).toEqual(["1", "2", "3"]);
    expect(numberOf(auctionLists[2])).toEqual(["1", "2", "3"]);
  });

  it("renders the troubleshooting list as native <details> (no JavaScript needed), one per message, closed by default", async () => {
    const page = readMessages(locale).tradeGuidePage;
    const { container } = render(await TradeGuidePage());
    const details = [...container.querySelectorAll("section#faq details")];
    // minus the section title and the two row labels
    expect(details).toHaveLength(Object.keys(page.faq).length - 3);
    for (const entry of details) {
      expect(entry.querySelector("summary")).not.toBeNull();
      expect(entry.hasAttribute("open")).toBe(false);
      // three points per entry: the message (summary), why (dt/dd) and what to do (dt/dd)
      expect([...entry.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual([
        page.faq.reasonLabel,
        page.faq.actionLabel,
      ]);
    }
    // "Details" boxes: one at the end of the listing section and one for auctions, closed.
    for (const id of ["offer", "auction"]) {
      const box = container.querySelector(`section#${id} details`)!;
      expect(box.hasAttribute("open")).toBe(false);
      expect(box.querySelector("summary")!.textContent).toBe(page[id].rules.summary);
    }
    // Section A is short enough to need no folded part.
    expect(container.querySelector("section#accept details")).toBeNull();
    // The page's own interaction needs no form control or client island.
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
  });

  it("links the three choice cards to their sections (and the streamer link to the last one)", async () => {
    const { container } = render(await TradeGuidePage());
    const cards = [...container.querySelectorAll("section#choose a")].map((a) => a.getAttribute("href"));
    expect(cards).toEqual(["#accept", "#offer", "#auction"]);
    const all = [...container.querySelectorAll("main a[href^='#']")].map((a) => a.getAttribute("href"));
    expect(all).toEqual(["#streamer", "#accept", "#offer", "#auction"]);
    for (const href of all) {
      expect(container.querySelector(href!)).not.toBeNull();
    }
    // The cards are the headings' short forms: each leads to a section whose heading is A / B / C.
    const letters = [...container.querySelectorAll("section#choose a span[aria-hidden='true']")].map((el) => el.textContent);
    expect(letters).toEqual(["A", "B", "C"]);
    const headingLetters = ["accept", "offer", "auction"].map(
      (id) => container.querySelector(`section#${id} > h2 > span[aria-hidden='true']`)!.textContent,
    );
    expect(headingLetters).toEqual(["A", "B", "C"]);
  });
});

describe("/guide/trade header", () => {
  it("shows the dashboard button for logged-in users instead of the home link", async () => {
    mocks.getSession.mockResolvedValue({ twitchUserId: "viewer-1" });
    render(await TradeGuidePage());
    expect(screen.getByRole("link", { name: readMessages("ja").header.dashboard })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.queryByRole("link", { name: readMessages("ja").guidePage.home })).toBeNull();
  });

  it("exports static English metadata like the other public help pages", () => {
    expect(metadata.title).toBe("Card Trading Guide - TwiCa");
    expect(metadata.description).toBeTruthy();
  });
});
