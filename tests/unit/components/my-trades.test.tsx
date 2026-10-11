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
    tradeable: true,
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

function renderMine(props: React.ComponentProps<typeof MyTrades> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <MyTrades {...props} />
    </NextIntlClientProvider>,
  );
}

function listCalls(fetchMock: ReturnType<typeof vi.fn>, status: string) {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).startsWith("/api/trades/mine")
    && new URL(String(url), "https://x.test").searchParams.get("status") === status,
  ).length;
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
    const boardLink = screen.getByRole("link", { name: ja.myTradesBoardLink });
    expect(boardLink).toHaveAttribute("href", "/trade/s-1");
    // Open offers keep a real action footer and its cancel button.
    const footer = boardLink.closest(".border-t");
    expect(footer).not.toBeNull();
    expect(within(footer as HTMLElement).getByRole("button", { name: ja.cancelOfferButton })).toBeEnabled();
  });

  it("cancels an open offer after the confirmation dialog and refetches", async () => {
    renderMine();
    fireEvent.click(await screen.findByRole("button", { name: ja.cancelOfferButton }));

    // In-app dialog instead of window.confirm (#1754 item 5): it names the
    // offer being withdrawn and focuses the non-destructive button.
    const dialog = screen.getByRole("dialog", { name: ja.cancelOfferConfirm });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByText("Offered Dragon")).toBeInTheDocument();
    expect(within(dialog).getByText("Wanted Slime")).toBeInTheDocument();
    expect(within(dialog).getByText(ja.myTradesGive)).toBeInTheDocument();
    expect(within(dialog).getByText(ja.myTradesWant)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ja.cancelOfferModalDismissButton })).toHaveFocus();
    // Opening the dialog must not send anything yet.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/cancel"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: ja.cancelOfferModalConfirmButton }));
    expect(await screen.findByText(ja.cancelOfferSuccess)).toBeInTheDocument();
    expect(await screen.findByText(ja.myTradesEmptyOpen)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    const cancelCall = fetchMock.mock.calls.find(([url]) => url === "/api/trades/offer-1/cancel");
    expect(cancelCall![1]).toEqual(expect.objectContaining({ method: "POST" }));
  });

  it("does not cancel when the confirmation dialog is dismissed", async () => {
    renderMine();
    const openButton = await screen.findByRole("button", { name: ja.cancelOfferButton });
    fireEvent.click(openButton);
    fireEvent.click(screen.getByRole("button", { name: ja.cancelOfferModalDismissButton }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/cancel"))).toBe(false);
    // The row is still there, so focus returns to its cancel button.
    await waitFor(() => expect(openButton).toHaveFocus());
  });

  it("shows the coded error when the offer was completed meanwhile", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/trades/mine")) {
        return jsonResponse(200, { offers: byStatus.open, page: 1, pageSize: 20, hasMore: false });
      }
      return jsonResponse(409, { error: "x", code: "TRADE_OFFER_NOT_OPEN" });
    });
    renderMine();
    fireEvent.click(await screen.findByRole("button", { name: ja.cancelOfferButton }));
    fireEvent.click(screen.getByRole("button", { name: ja.cancelOfferModalConfirmButton }));
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
    // Completed rows still need the footer for counterpart information.
    for (const item of items) {
      expect(item.querySelector(".border-t")).toHaveTextContent("取引相手:");
    }
  });

  it("omits the empty action footer on cancelled history, including a cached tab revisit", async () => {
    byStatus.cancelled = [makeOffer({ status: "cancelled" })];
    byStatus.completed = [makeOffer({
      id: "completed-offer",
      status: "completed",
      offeredCard: { name: "Completed Dragon", rarity: "epic", imageUrl: null },
      acceptedBy: { twitchUsername: "bob", twitchDisplayName: "Bob", twitchProfileImageUrl: null },
    })];
    renderMine();
    await screen.findByText("Offered Dragon");
    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCancelled }));
    await waitFor(() => expect(lastListQuery(fetchMock).get("status")).toBe("cancelled"));
    await screen.findByText(/^キャンセル日時:/);

    const assertCancelledRow = () => {
      const item = screen.getByRole("listitem");
      expect(within(item).getByText("Offered Dragon")).toBeInTheDocument();
      expect(within(item).getByText("Wanted Slime")).toBeInTheDocument();
      expect(within(item).getByText(ja.myTradesRoleOfferer)).toBeInTheDocument();
      expect(within(item).getByText(/^キャンセル日時:/)).toBeInTheDocument();
      expect(item.querySelector(".border-t")).toBeNull();
      expect(within(item).queryByRole("link")).toBeNull();
      expect(within(item).queryByRole("button")).toBeNull();
    };
    assertCancelledRow();

    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCompleted }));
    await screen.findByText("Completed Dragon");
    expect(screen.getByRole("listitem").querySelector(".border-t")).toHaveTextContent("取引相手: Bob");
    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabOpen }));
    expect(screen.getByRole("button", { name: ja.cancelOfferButton })).toBeEnabled();
    fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCancelled }));
    assertCancelledRow();
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
    byStatus.open = [makeOffer({ wantedCardId: null, tradeable: false })];
    renderMine();
    expect(await screen.findByText(ja.myTradesUnavailableBadge)).toBeInTheDocument();
    expect(screen.getByText(ja.myTradesUnavailableHelp)).toBeInTheDocument();
    // Still cancellable.
    expect(screen.getByRole("button", { name: ja.cancelOfferButton })).toBeEnabled();
  });

  it("marks open offers the API reports as no longer tradeable (#1754 item 4)", async () => {
    byStatus.open = [makeOffer({ tradeable: false })];
    renderMine();
    expect(await screen.findByText(ja.myTradesUnavailableBadge)).toBeInTheDocument();
    // The cards still exist, so the copy explains the setting change instead
    // of blaming a deleted card.
    expect(screen.getByText(ja.myTradesUnavailableHelpNotTradeable)).toBeInTheDocument();
    expect(screen.queryByText(ja.myTradesUnavailableHelp)).toBeNull();
    expect(screen.getByRole("button", { name: ja.cancelOfferButton })).toBeEnabled();
  });

  it("keeps tradeable open offers unmarked", async () => {
    byStatus.open = [makeOffer()];
    renderMine();
    await screen.findByText("Offered Dragon");
    expect(screen.queryByText(ja.myTradesUnavailableBadge)).toBeNull();
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

  describe("client cache (tab switching without reloading)", () => {
    it("renders the server-rendered open tab immediately and revalidates it once in the background", async () => {
      renderMine({ initialOpen: { offers: [makeOffer({ offeredCard: { name: "SSR Dragon", rarity: "epic", imageUrl: null } })], hasMore: false } });
      // Synchronously present: no loading state before the client round trip.
      expect(screen.getByText("SSR Dragon")).toBeInTheDocument();
      expect(screen.queryByText(ja.loading)).toBeNull();
      // The SSR payload may be a router-cache replay (browser back/forward)
      // older than the user's last cancel, so it is always revalidated once.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listCalls(fetchMock, "open")).toBe(1);
      expect(screen.queryByText(ja.loading)).toBeNull();
    });

    it("shows a fetched tab again immediately, without loading or a new request", async () => {
      renderMine();
      await screen.findByText("Offered Dragon");
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCompleted }));
      expect(await screen.findByText(ja.myTradesEmptyCompleted)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabOpen }));
      expect(screen.getByText("Offered Dragon")).toBeInTheDocument();
      expect(screen.queryByText(ja.loading)).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCompleted }));
      expect(screen.getByText(ja.myTradesEmptyCompleted)).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listCalls(fetchMock, "open")).toBe(1);
      expect(listCalls(fetchMock, "completed")).toBe(1);
    });

    it("keeps showing a stale tab while refreshing it in the background", async () => {
      const now = vi.spyOn(Date, "now");
      now.mockReturnValue(1_000_000);
      renderMine();
      await screen.findByText("Offered Dragon");
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCompleted }));
      await screen.findByText(ja.myTradesEmptyCompleted);

      // Past the freshness window: shown from cache at once, then replaced.
      now.mockReturnValue(1_000_000 + 31_000);
      byStatus.open = [makeOffer({ id: "offer-new", offeredCard: { name: "Fresh Golem", rarity: "rare", imageUrl: null } })];
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabOpen }));
      expect(screen.getByText("Offered Dragon")).toBeInTheDocument();
      expect(screen.queryByText(ja.loading)).toBeNull();
      expect(await screen.findByText("Fresh Golem")).toBeInTheDocument();
      expect(listCalls(fetchMock, "open")).toBe(2);
    });

    it("keeps the cached rows when a background refresh fails", async () => {
      const now = vi.spyOn(Date, "now");
      now.mockReturnValue(1_000_000);
      renderMine();
      await screen.findByText("Offered Dragon");
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCompleted }));
      await screen.findByText(ja.myTradesEmptyCompleted);

      now.mockReturnValue(1_000_000 + 31_000);
      fetchMock.mockImplementation(async () => jsonResponse(500, { code: "INTERNAL_ERROR" }));
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabOpen }));
      await waitFor(() => expect(listCalls(fetchMock, "open")).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByText("Offered Dragon")).toBeInTheDocument();
      expect(screen.queryByText(ja.myTradesLoadError)).toBeNull();
    });

    it("after a cancel: removes the row at once and reloads the other tabs on their next visit", async () => {
      let releaseRefresh: () => void = () => {};
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      renderMine();
      await screen.findByText("Offered Dragon");
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCancelled }));
      await screen.findByText(ja.myTradesEmptyCancelled);
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabOpen }));
      expect(screen.getByText("Offered Dragon")).toBeInTheDocument();

      const baseImpl = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === "/api/trades/offer-1/cancel") {
          byStatus.cancelled = [makeOffer({ status: "cancelled" })];
        }
        // Hold the background refresh of the open tab so the optimistic
        // removal is observable on its own.
        if (url.startsWith("/api/trades/mine?status=open")) await refreshGate;
        return baseImpl(url, init);
      });
      fireEvent.click(screen.getByRole("button", { name: ja.cancelOfferButton }));
      fireEvent.click(screen.getByRole("button", { name: ja.cancelOfferModalConfirmButton }));
      expect(await screen.findByText(ja.cancelOfferSuccess)).toBeInTheDocument();
      expect(screen.queryByText("Offered Dragon")).toBeNull();
      expect(screen.getByText(ja.myTradesEmptyOpen)).toBeInTheDocument();
      releaseRefresh();
      await waitFor(() => expect(listCalls(fetchMock, "open")).toBe(2));

      // The cancelled tab was cached empty before the cancel; it must not be
      // reused now.
      fireEvent.click(screen.getByRole("tab", { name: ja.myTradesTabCancelled }));
      expect(await screen.findByText("Offered Dragon")).toBeInTheDocument();
      expect(listCalls(fetchMock, "cancelled")).toBe(2);
    });
  });
});
