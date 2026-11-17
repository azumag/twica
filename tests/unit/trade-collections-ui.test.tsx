import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TradeCollectionSection } from "@/lib/trade-collections";

/**
 * #2079: hub collection list behaviour that the server tests cannot cover:
 * the empty/error states, the sort navigation, and the "6th row onwards"
 * fetch through GET /api/trades/collections/[streamerId].
 *
 * The row components are replaced with probes: this suite is about which rows
 * are shown and which URL is fetched. Their own rendering is covered by the
 * existing trade component tests.
 */
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    values?.count === undefined ? key : `${key}:${values.count}`,
}));
vi.mock("@/components/MaintenanceStatusProvider", () => ({
  useMaintenanceStatus: () => ({ mode: "off" }),
}));
vi.mock("@/components/TradeOfferRow", () => ({
  default: ({ offer }: { offer: { id: string } }) => (
    <li data-testid="offer-row" data-offer-id={offer.id} />
  ),
}));
vi.mock("@/components/TradeAuctionRow", () => ({
  default: ({ auction }: { auction: { id: string } }) => (
    <li data-testid="auction-row" data-auction-id={auction.id} />
  ),
}));
vi.mock("@/components/TradeAcceptModal", () => ({ default: () => null }));

import TradeCollections from "@/components/TradeCollections";

const STREAMER = {
  id: "11111111-1111-4111-8111-111111111111",
  twitchUsername: "channel",
  twitchDisplayName: "Channel",
  twitchProfileImageUrl: null,
};

function section(overrides: Partial<TradeCollectionSection> = {}): TradeCollectionSection {
  return {
    streamer: STREAMER,
    offers: Array.from({ length: 5 }, (_, index) => ({ id: `offer-${index + 1}` })) as never,
    offerTotal: 7,
    auctions: [],
    auctionTotal: 0,
    latestCreatedAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

function rows(prefix: string, from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => ({
    id: `${prefix}-${from + index}`,
  }));
}

function page(body: unknown) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("TradeCollections (#2079)", () => {
  it("shows the empty state when no collection has listings", () => {
    render(<TradeCollections initialCollections={[]} sort="newest" />);
    expect(screen.getByText("collectionsEmpty")).toBeInTheDocument();
    expect(screen.getByLabelText("collectionSortLabel")).toHaveValue("newest");
  });

  it("shows the retry state when the SSR prefetch failed", () => {
    render(<TradeCollections initialCollections={null} sort="newest" />);
    expect(screen.getByText("collectionsLoadError")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retryButton" }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("navigates to the server-rendered sort URL", () => {
    render(<TradeCollections initialCollections={[section()]} sort="newest" />);
    fireEvent.change(screen.getByLabelText("collectionSortLabel"), {
      target: { value: "ending_soon" },
    });
    expect(mocks.push).toHaveBeenCalledWith("/trade?sort=ending_soon");
  });

  it("fetches rows 6+ from the collection endpoint and can collapse again", async () => {
    const fetched = {
      offers: Array.from({ length: 6 }, (_, index) => ({ id: `expanded-${index + 1}` })),
      total: 7,
      hasMore: false,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fetched,
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TradeCollections initialCollections={[section()]} sort="newest" />);
    expect(screen.getAllByTestId("offer-row")).toHaveLength(5);
    // 5 shown of 7 → the expand button is offered with the TOTAL count.
    expect(screen.getByRole("button", { name: "collectionExpand:7" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:7" }));

    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(6));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/trades/collections/${STREAMER.id}?kind=offer&sort=newest&page=1`,
      { credentials: "include", cache: "no-store" },
    );

    fireEvent.click(screen.getByRole("button", { name: "collectionCollapse" }));
    expect(screen.getAllByTestId("offer-row")).toHaveLength(5);
  });

  it("drops expanded pages when a server refresh replaces the sections", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      page({ offers: rows("expanded", 1, 7), total: 7, hasMore: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <TradeCollections initialCollections={[section()]} sort="newest" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:7" }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(7));

    // <MyTrades> cancelled a listing and called router.refresh(): the server
    // sends a new section, but the expand API's rows were ranked before the
    // card was released, so they must not keep the stale canAccept flags.
    rerender(
      <TradeCollections
        initialCollections={[section({ offerTotal: 8 })]}
        sort="newest"
      />,
    );
    expect(screen.getAllByTestId("offer-row")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "collectionCollapse" })).toBeNull();
  });

  it("appends the next page and hides the button when hasMore is false", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page({ offers: rows("expanded", 1, 20), total: 23, hasMore: true }))
      .mockResolvedValueOnce(page({ offers: rows("expanded", 21, 23), total: 23, hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TradeCollections initialCollections={[section({ offerTotal: 23 })]} sort="newest" />);
    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:23" }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(20));

    // #2079 review: cross-channel listings are not reachable from the
    // in-channel board tab, so there must be no /trade/<streamer> "see more"
    // link at all; the remaining rows are fetched here instead.
    expect(document.querySelector(`a[href^="/trade/${STREAMER.id}"]`)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "collectionLoadMore" }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(23));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/trades/collections/${STREAMER.id}?kind=offer&sort=newest&page=2`,
      { credentials: "include", cache: "no-store" },
    );
    expect(screen.queryByRole("button", { name: "collectionLoadMore" })).toBeNull();
  });

  it("does not show a row twice when the pages overlap", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page({ offers: rows("expanded", 1, 20), total: 21, hasMore: true }))
      .mockResolvedValueOnce(page({ offers: rows("expanded", 20, 21), total: 21, hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TradeCollections initialCollections={[section({ offerTotal: 21 })]} sort="newest" />);
    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:21" }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(20));
    fireEvent.click(screen.getByRole("button", { name: "collectionLoadMore" }));

    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(21));
    const ids = screen.getAllByTestId("offer-row").map((row) => row.getAttribute("data-offer-id"));
    expect(ids.filter((id) => id === "expanded-20")).toHaveLength(1);
    expect(ids.filter((id) => id === "expanded-21")).toHaveLength(1);
  });

  it("keeps the rows already shown and retries the same page when appending fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page({ offers: rows("expanded", 1, 20), total: 22, hasMore: true }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(page({ offers: rows("expanded", 21, 22), total: 22, hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TradeCollections initialCollections={[section({ offerTotal: 22 })]} sort="newest" />);
    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:22" }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(20));
    fireEvent.click(screen.getByRole("button", { name: "collectionLoadMore" }));

    expect(await screen.findByText("collectionsLoadError")).toBeInTheDocument();
    expect(screen.getAllByTestId("offer-row")).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: "retryButton" }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(22));
    expect(screen.queryByText("collectionsLoadError")).toBeNull();
    // The retry must resume at page 2, not restart at page 1.
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `/api/trades/collections/${STREAMER.id}?kind=offer&sort=newest&page=2`,
      { credentials: "include", cache: "no-store" },
    );
  });

  it("disables the load-more button while the next page is in flight", async () => {
    let resolveSecond: (value: unknown) => void = () => {};
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page({ offers: rows("expanded", 1, 20), total: 21, hasMore: true }))
      .mockReturnValueOnce(second);
    vi.stubGlobal("fetch", fetchMock);

    render(<TradeCollections initialCollections={[section({ offerTotal: 21 })]} sort="newest" />);
    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:21" }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(20));

    fireEvent.click(screen.getByRole("button", { name: "collectionLoadMore" }));
    const loading = screen.getByRole("button", { name: "collectionExpanding" });
    expect(loading).toBeDisabled();
    fireEvent.click(loading);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolveSecond(page({ offers: rows("expanded", 21, 21), total: 21, hasMore: false }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(21));
  });

  it("stays collapsed when the next page arrives after collapsing", async () => {
    let resolveSecond: (value: unknown) => void = () => {};
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page({ offers: rows("expanded", 1, 20), total: 21, hasMore: true }))
      .mockReturnValueOnce(second);
    vi.stubGlobal("fetch", fetchMock);

    render(<TradeCollections initialCollections={[section({ offerTotal: 21 })]} sort="newest" />);
    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:21" }));
    await waitFor(() => expect(screen.getAllByTestId("offer-row")).toHaveLength(20));
    fireEvent.click(screen.getByRole("button", { name: "collectionLoadMore" }));
    fireEvent.click(screen.getByRole("button", { name: "collectionCollapse" }));
    expect(screen.getAllByTestId("offer-row")).toHaveLength(5);

    // The late page must not re-expand the section with page 2 only.
    await act(async () => {
      resolveSecond(page({ offers: rows("expanded", 21, 21), total: 21, hasMore: false }));
    });
    expect(screen.getAllByTestId("offer-row")).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "collectionCollapse" })).toBeNull();
  });

  it("appends auction pages with the same de-duplication", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page({ auctions: rows("auction", 1, 20), total: 21, hasMore: true }))
      .mockResolvedValueOnce(page({ auctions: rows("auction", 20, 21), total: 21, hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TradeCollections
        initialCollections={[section({
          offers: [],
          offerTotal: 0,
          auctions: rows("auction", 1, 5) as never,
          auctionTotal: 21,
        })]}
        sort="newest"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "collectionExpand:21" }));
    await waitFor(() => expect(screen.getAllByTestId("auction-row")).toHaveLength(20));
    fireEvent.click(screen.getByRole("button", { name: "collectionLoadMore" }));

    await waitFor(() => expect(screen.getAllByTestId("auction-row")).toHaveLength(21));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/trades/collections/${STREAMER.id}?kind=auction&sort=newest&page=2`,
      { credentials: "include", cache: "no-store" },
    );
    const ids = screen.getAllByTestId("auction-row").map((row) => row.getAttribute("data-auction-id"));
    expect(ids.filter((id) => id === "auction-20")).toHaveLength(1);
  });
});
