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

  it("renders for anonymous visitors with the title, every section and the footer", async () => {
    const page = readMessages(locale).tradeGuidePage;
    render(await TradeGuidePage());

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(page.title);
    for (const id of ["overview", "offer", "auction", "streamer", "faq"] as const) {
      const heading = screen.getByRole("heading", { level: 2, name: page[id].title });
      expect(heading.closest("section")).toHaveAttribute("id", id);
    }
    expect(screen.getByTestId("public-footer")).toBeInTheDocument();
    // 未ログインでも閲覧でき、ホームへ戻れる（/guide と同じヘッダー）
    expect(screen.getByRole("link", { name: readMessages(locale).guidePage.home })).toHaveAttribute("href", "/");
  });

  it("renders every message of the namespace (no orphan copy, no raw key paths)", async () => {
    const page = readMessages(locale).tradeGuidePage;
    const { container } = render(await TradeGuidePage());
    // Visible text plus aria-labels: a few strings (toc / tabsLabel) are accessible names.
    const labels = [...container.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label"));
    const everything = `${container.textContent ?? ""}\n${labels.join("\n")}`;

    // metaDescription / entryLink are consumed by the metadata and the trade layout,
    // durationSeparator is folded into the "24h / 3d / 7d" chip text.
    const elsewhere = new Set(["metaDescription", "entryLink", "hero.durationSeparator"]);
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
    const durations = [trade.createAuctionDuration24h, trade.createAuctionDuration3d, trade.createAuctionDuration7d];

    // The labels are looked up per hour value; make sure the lookup covers the constant.
    expect([...TRADE_AUCTION_DURATIONS_HOURS]).toEqual([24, 72, 168]);

    expect(text).toContain(fill(page.hero.offerChipWanted, { max: TRADE_MAX_WANTED_QUANTITY }));
    expect(text).toContain(fill(page.hero.offerChipListings, { max: TRADE_MAX_OPEN_OFFERS }));
    expect(text).toContain(
      fill(page.hero.auctionChipDuration, { durations: durations.join(page.hero.durationSeparator) }),
    );
    expect(text).toContain(fill(page.hero.auctionChipSelection, { hours: TRADE_AUCTION_SELECTION_HOURS }));
    expect(text).toContain(fill(page.offer.exchange.wantCount, { max: TRADE_MAX_WANTED_QUANTITY }));
    expect(text).toContain(fill(page.offer.points.limit.title, { max: TRADE_MAX_OPEN_OFFERS }));
    expect(text).toContain(fill(page.auction.timeline.maxHours, { hours: TRADE_AUCTION_SELECTION_HOURS }));
    expect(text).toContain(fill(page.auction.timeline.noBids, { hours: TRADE_AUCTION_SELECTION_HOURS }));
    expect(text).toContain(fill(page.auction.roles.bidder.bid.description, { max: TRADE_MAX_BID_QUANTITY }));
    expect(text).toContain(fill(page.auction.rules.bidShape, { max: TRADE_MAX_BID_QUANTITY }));
    expect(text).toContain(fill(page.auction.rules.activeBids, { max: TRADE_MAX_ACTIVE_BIDS }));
    expect(text).toContain(fill(page.auction.rules.listings, { max: TRADE_MAX_OPEN_OFFERS }));
    expect(text).toContain(
      fill(page.faq.limitReached.answer, { maxListings: TRADE_MAX_OPEN_OFFERS, maxBids: TRADE_MAX_ACTIVE_BIDS }),
    );
    expect(text).toContain(fill(page.faq.selectionExpired.answer, { hours: TRADE_AUCTION_SELECTION_HOURS }));
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
      // board chrome
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

    // Diagrams that carry meaning are <figure>s with a caption: exchange, cross-channel,
    // auction timeline and the two settings panels.
    const figures = [...container.querySelectorAll("figure")];
    expect(figures.length).toBeGreaterThanOrEqual(5);
    for (const figure of figures) {
      const caption = figure.querySelector("figcaption");
      expect(caption, figure.className).not.toBeNull();
      expect((caption!.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
    expect(container.querySelector("section#offer figure figcaption")!.textContent).toBe(
      page.offer.exchange.caption,
    );
    expect(container.querySelector("section#auction figure figcaption")!.textContent).toBe(
      fill(page.auction.timeline.caption, {
        durations: [
          readMessages(locale).trade.createAuctionDuration24h,
          readMessages(locale).trade.createAuctionDuration3d,
          readMessages(locale).trade.createAuctionDuration7d,
        ].join(page.hero.durationSeparator),
        hours: TRADE_AUCTION_SELECTION_HOURS,
      }),
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
    expect(settings).toContain(page.streamer.settings.stateOn);
    expect(settings).toContain(page.streamer.settings.stateOff);
  });

  it("builds the flows as real ordered lists numbered from the array order", async () => {
    const { container } = render(await TradeGuidePage());
    const numberOf = (list: Element) =>
      [...list.children].map((li) => li.querySelector("span.rounded-full")?.textContent);
    const offerFlow = container.querySelector("section#offer ol")!;
    expect(numberOf(offerFlow)).toEqual(["1", "2", "3"]);
    // auction: [0] is the timeline (no number badges), then the seller and bidder flows
    const auctionLists = [...container.querySelectorAll("section#auction ol")];
    expect(auctionLists).toHaveLength(3);
    expect(auctionLists[0].children).toHaveLength(4);
    expect(numberOf(auctionLists[1])).toEqual(["1", "2", "3", "4"]);
    expect(numberOf(auctionLists[2])).toEqual(["1", "2", "3"]);
  });

  it("renders the FAQ as native <details> (no JavaScript needed), one per question, closed by default", async () => {
    const page = readMessages(locale).tradeGuidePage;
    const { container } = render(await TradeGuidePage());
    const details = [...container.querySelectorAll("section#faq details")];
    expect(details).toHaveLength(Object.keys(page.faq).length - 1); // minus "title"
    for (const entry of details) {
      expect(entry.querySelector("summary")).not.toBeNull();
      expect(entry.hasAttribute("open")).toBe(false);
    }
    // The page's own interaction needs no form control or client island.
    expect(container.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
  });

  it("links the hero cards and the table of contents to the section anchors", async () => {
    const { container } = render(await TradeGuidePage());
    const toc = [...container.querySelectorAll('nav[aria-label] a[href^="#"]')].map((a) => a.getAttribute("href"));
    expect(toc).toEqual(["#overview", "#offer", "#auction", "#streamer", "#faq"]);
    const heroLinks = [...container.querySelectorAll("main > div a[href^='#']")].map((a) => a.getAttribute("href"));
    expect(heroLinks).toEqual(["#offer", "#auction"]);
    for (const href of [...toc, ...heroLinks]) {
      expect(container.querySelector(href!)).not.toBeNull();
    }
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
