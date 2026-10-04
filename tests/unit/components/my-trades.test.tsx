import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import MyTrades from "@/components/MyTrades";
import type { TradeOfferDto } from "@/lib/trade";
import jaMessages from "../../../messages/ja.json";

const ja = jaMessages.trade;

function makeOffer(overrides: Partial<TradeOfferDto> = {}): TradeOfferDto {
  return {
    id: "offer-1",
    offeredUserCardId: "uc-1",
    offeredCardId: "card-offered",
    offeredStreamerId: "s-1",
    wantedCardId: "card-wanted",
    wantedStreamerId: "s-1",
    offeredCard: { name: "Offered Dragon", rarity: "epic", imageUrl: null },
    wantedCard: { name: "Wanted Slime", rarity: "common", imageUrl: null },
    isCrossChannel: false,
    status: "open",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    completedAt: null,
    offerer: { twitchUsername: "me", twitchDisplayName: "Me", twitchProfileImageUrl: null },
    acceptedBy: null,
    offeredStreamer: null,
    wantedStreamer: null,
    isOwnOffer: true,
    mineRole: "offerer",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderMine() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MyTrades />
    </NextIntlClientProvider>,
  );
}

function lastListQuery(fetchMock: ReturnType<typeof vi.fn>) {
  const call = [...fetchMock.mock.calls].reverse().find(([url]) => String(url).startsWith("/api/trades/mine"));
  return new URL(String(call![0]), "https://x.test").searchParams;
}

describe("MyTrades (#727 §6.6)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let byStatus: Record<string, TradeOfferDto[]>;
  let hasMore: boolean;

  beforeEach(() => {
    byStatus = { open: [makeOffer()], completed: [], cancelled: [] };
    hasMore = false;
    fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/trades/mine")) {
        const status = new URL(url, "https://x.test").searchParams.get("status")!;
        return jsonResponse(200, { offers: byStatus[status], page: 1, pageSize: 20, hasMore });
      }
      if (url === "/api/trades/offer-1/cancel") {
        byStatus.open = [];
        return jsonResponse(200, { success: true, id: "offer-1" });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts on the open tab and requests status=open", async () => {
    renderMine();
    expect(await screen.findByText("Offered Dragon")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: ja.myTradesTabOpen })).toHaveAttribute("aria-selected", "true");
    expect(lastListQuery(fetchMock).get("status")).toBe("open");
    expect(screen.getByText(ja.myTradesGive)).toBeInTheDocument();
    expect(screen.getByText(ja.myTradesWant)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ja.myTradesBoardLink })).toHaveAttribute("href", "/trade/s-1");
  });

  it("cancels an open offer after confirmation and refetches", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderMine();
    fireEvent.click(await screen.findByRole("button", { name: ja.cancelOfferButton }));

    expect(window.confirm).toHaveBeenCalledWith(ja.cancelOfferConfirm);
    expect(await screen.findByText(ja.cancelOfferSuccess)).toBeInTheDocument();
    expect(await screen.findByText(ja.myTradesEmptyOpen)).toBeInTheDocument();
    const cancelCall = fetchMock.mock.calls.find(([url]) => url === "/api/trades/offer-1/cancel");
    expect(cancelCall![1]).toEqual(expect.objectContaining({ method: "POST" }));
  });

  it("does nothing when the confirmation is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderMine();
    fireEvent.click(await screen.findByRole("button", { name: ja.cancelOfferButton }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/cancel"))).toBe(false);
  });

  it("shows the coded error when the offer was completed meanwhile", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/trades/mine")) {
        return jsonResponse(200, { offers: byStatus.open, page: 1, pageSize: 20, hasMore: false });
      }
      return jsonResponse(409, { error: "x", code: "TRADE_OFFER_NOT_OPEN" });
    });
    renderMine();
    fireEvent.click(await screen.findByRole("button", { name: ja.cancelOfferButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeAlreadyCompletedOrInvalid);
  });

  it("completed tab: counterpart is acceptedBy for my offers and offerer for offers I accepted", async () => {
    byStatus.completed = [
      makeOffer({
        id: "mine-listed",
        status: "completed",
        completedAt: "2026-10-02T00:00:00.000Z",
        acceptedBy: { twitchUsername: "bob", twitchDisplayName: "Bob", twitchProfileImageUrl: null },
        mineRole: "offerer",
      }),
      makeOffer({
        id: "mine-accepted",
        status: "completed",
        completedAt: "2026-10-03T00:00:00.000Z",
        offerer: { twitchUsername: "carol", twitchDisplayName: "Carol", twitchProfileImageUrl: null },
        acceptedBy: { twitchUsername: "me", twitchDisplayName: "Me", twitchProfileImageUrl: null },
        offeredCard: { name: "Carol Card", rarity: "rare", imageUrl: null },
        wantedCard: { name: "My Old Card", rarity: "common", imageUrl: null },
        isOwnOffer: false,
        mineRole: "acceptor",
      }),
    ];
    renderMine();
    await screen.findByText("Offered Dragon");
    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCompleted }));

    const items = await screen.findAllByRole("listitem");
    expect(lastListQuery(fetchMock).get("status")).toBe("completed");
    expect(within(items[0]).getByText("取引相手: Bob")).toBeInTheDocument();
    expect(within(items[0]).getByText(ja.myTradesRoleOfferer)).toBeInTheDocument();

    const accepted = items[1];
    expect(within(accepted).getByText("取引相手: Carol")).toBeInTheDocument();
    expect(within(accepted).getByText(ja.myTradesRoleAcceptor)).toBeInTheDocument();
    // For an offer I accepted I gave the wanted card and received the offered one.
    const gave = within(accepted).getByText(ja.myTradesGave).parentElement!;
    const received = within(accepted).getByText(ja.myTradesReceived).parentElement!;
    expect(gave).toHaveTextContent("My Old Card");
    expect(received).toHaveTextContent("Carol Card");
    expect(within(accepted).queryByRole("button", { name: ja.cancelOfferButton })).toBeNull();
  });

  it("shows deleted card definitions from the snapshot with a deleted label", async () => {
    byStatus.completed = [
      makeOffer({
        status: "completed",
        offeredCardId: null,
        offeredCard: { name: "Retired Hero", rarity: "legendary", imageUrl: null },
        acceptedBy: null,
      }),
    ];
    renderMine();
    await screen.findByText("Offered Dragon");
    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCompleted }));
    expect(await screen.findByText("Retired Hero")).toBeInTheDocument();
    expect(screen.getByText(ja.deletedCardLabel)).toBeInTheDocument();
    expect(screen.getByText(`取引相手: ${ja.unknownUser}`)).toBeInTheDocument();
  });

  it("marks open offers that can no longer be accepted (deleted card)", async () => {
    byStatus.open = [makeOffer({ wantedCardId: null })];
    renderMine();
    expect(await screen.findByText(ja.myTradesUnavailableBadge)).toBeInTheDocument();
    expect(screen.getByText(ja.myTradesUnavailableHelp)).toBeInTheDocument();
    // Still cancellable.
    expect(screen.getByRole("button", { name: ja.cancelOfferButton })).toBeEnabled();
  });

  it("supports arrow-key navigation between tabs (roving tabindex)", async () => {
    renderMine();
    await screen.findByText("Offered Dragon");
    const openTab = screen.getByRole("tab", { name: ja.myTradesTabOpen });
    expect(openTab).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: ja.myTradesTabCompleted })).toHaveAttribute("tabindex", "-1");
    openTab.focus();
    fireEvent.keyDown(openTab, { key: "ArrowRight" });
    const completed = screen.getByRole("tab", { name: ja.myTradesTabCompleted });
    expect(completed).toHaveAttribute("aria-selected", "true");
    expect(completed).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", completed.id);
    fireEvent.keyDown(completed, { key: "End" });
    expect(screen.getByRole("tab", { name: ja.myTradesTabCancelled })).toHaveAttribute("aria-selected", "true");
    await screen.findByText(ja.myTradesEmptyCancelled);
  });

  it("steps back a page when a later page became empty", async () => {
    hasMore = true;
    renderMine();
    await screen.findByText("Offered Dragon");
    byStatus.open = [];
    hasMore = false;
    fetchMock.mockImplementation(async (url: string) => {
      const query = new URL(url, "https://x.test").searchParams;
      const offers = query.get("page") === "1" ? [makeOffer()] : [];
      return jsonResponse(200, { offers, page: 1, pageSize: 20, hasMore: false });
    });
    fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.next }));
    await waitFor(() => expect(lastListQuery(fetchMock).get("page")).toBe("1"));
    expect(await screen.findByText("Offered Dragon")).toBeInTheDocument();
    expect(screen.queryByText(ja.myTradesEmptyOpen)).toBeNull();
  });

  it("shows per-tab empty states", async () => {
    renderMine();
    await screen.findByText("Offered Dragon");
    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCancelled }));
    expect(await screen.findByText(ja.myTradesEmptyCancelled)).toBeInTheDocument();
    expect(lastListQuery(fetchMock).get("status")).toBe("cancelled");
  });

  it("pages within a tab and resets to page 1 on tab change", async () => {
    hasMore = true;
    renderMine();
    await screen.findByText("Offered Dragon");
    fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.next }));
    await waitFor(() => expect(lastListQuery(fetchMock).get("page")).toBe("2"));
    await screen.findByText("Offered Dragon");

    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCompleted }));
    await waitFor(() => {
      const query = lastListQuery(fetchMock);
      expect(query.get("status")).toBe("completed");
      expect(query.get("page")).toBe("1");
    });
  });
});
