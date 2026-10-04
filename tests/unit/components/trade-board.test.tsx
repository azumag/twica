import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TradeBoard from "@/components/TradeBoard";
import TradeOfferRow from "@/components/TradeOfferRow";
import type { TradeOfferDto } from "@/lib/trade";
import { tradeBoardPath, tradeLoginHref } from "@/lib/trade-client";
import { clearTradeListCache } from "@/lib/use-trade-list";
import jaMessages from "../../../messages/ja.json";

const ja = jaMessages.trade;

function makeOffer(overrides: Partial<TradeOfferDto> = {}): TradeOfferDto {
  return {
    id: "offer-1",
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
    offerer: { twitchUsername: "alice", twitchDisplayName: "Alice", twitchProfileImageUrl: null },
    acceptedBy: null,
    offeredStreamer: { id: "s-1", twitchUsername: "chan", twitchDisplayName: "ChanOne", twitchProfileImageUrl: null },
    wantedStreamer: { id: "s-2", twitchUsername: "other", twitchDisplayName: "ChanTwo", twitchProfileImageUrl: null },
    isOwnOffer: false,
    canAccept: "yes",
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function listResponse(offers: TradeOfferDto[], hasMore = false) {
  return jsonResponse(200, { offers, page: 1, pageSize: 20, hasMore });
}

const LOGIN_HREF = tradeLoginHref(tradeBoardPath("s-1", "cross_channel"));

function renderRow(offer: TradeOfferDto, props: Partial<React.ComponentProps<typeof TradeOfferRow>> = {}) {
  const onAccept = vi.fn();
  render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <ul>
        <TradeOfferRow
          offer={offer}
          showStreamers={false}
          isLoggedIn
          loginHref={LOGIN_HREF}
          writeBlocked={false}
          onAccept={onAccept}
          {...props}
        />
      </ul>
    </NextIntlClientProvider>,
  );
  return { onAccept };
}

describe("TradeOfferRow accept states (§11.3)", () => {
  it("yes → enabled purple accept button that opens the dialog", () => {
    const { onAccept } = renderRow(makeOffer({ canAccept: "yes" }));
    const button = screen.getByRole("button", { name: ja.acceptButton });
    expect(button).toBeEnabled();
    expect(button.className).toContain("bg-purple-600");
    fireEvent.click(button);
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ id: "offer-1" }), button);
  });

  it("not_owned → disabled gray 'not owned'", () => {
    renderRow(makeOffer({ canAccept: "not_owned" }));
    const button = screen.getByRole("button", { name: ja.acceptButtonNotOwned });
    expect(button).toBeDisabled();
    expect(button.className).toContain("bg-gray-700");
  });

  it("all_listed → disabled gray with a label distinct from not_owned", () => {
    renderRow(makeOffer({ canAccept: "all_listed" }));
    expect(screen.getByRole("button", { name: ja.acceptButtonAllListed })).toBeDisabled();
    expect(screen.queryByText(ja.acceptButtonNotOwned)).toBeNull();
  });

  it("anonymous → 'log in to accept' link carrying the encoded returnTo with scope", () => {
    renderRow(makeOffer({ canAccept: undefined, isOwnOffer: undefined }), { isLoggedIn: false });
    const link = screen.getByRole("link", { name: ja.acceptButtonLoginRequired });
    expect(link).toHaveAttribute(
      "href",
      "/api/auth/twitch/login?redirect=true&returnTo=%2Ftrade%2Fs-1%3Fscope%3Dcross",
    );
    expect(screen.queryByRole("button", { name: ja.acceptButton })).toBeNull();
  });

  it("own offer → badge and /trade/mine link instead of an accept button", () => {
    renderRow(makeOffer({ isOwnOffer: true, canAccept: undefined }));
    expect(screen.getByText(ja.ownOfferBadge)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ja.ownOfferManageLink })).toHaveAttribute("href", "/trade/mine");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(ja.autoSelectNotice)).toBeNull();
  });

  it("always shows the auto-select notice next to the accept action", () => {
    renderRow(makeOffer({ canAccept: "not_owned" }));
    expect(screen.getByText(ja.autoSelectNotice)).toBeInTheDocument();
  });

  it("shows the viewer's direction: receive (offered card) first, then give", () => {
    renderRow(makeOffer());
    const receive = screen.getByText(ja.receiveLabel);
    const give = screen.getByText(ja.giveLabel);
    // DOCUMENT_POSITION_FOLLOWING: give comes after receive.
    expect(receive.compareDocumentPosition(give) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("img", { name: ja.directionIconLabel })).toHaveTextContent("⇄");
  });

  it("stacks vertically on mobile and side by side from sm", () => {
    renderRow(makeOffer());
    const cardsRow = screen.getByRole("img", { name: ja.directionIconLabel }).parentElement!;
    expect(cardsRow.className).toContain("flex-col");
    expect(cardsRow.className).toContain("sm:flex-row");
  });

  it("shows each card's channel only on the cross-channel tab", () => {
    renderRow(makeOffer({ isCrossChannel: true }), { showStreamers: true });
    expect(screen.getByText("ChanOne のカード")).toBeInTheDocument();
    expect(screen.getByText("ChanTwo のカード")).toBeInTheDocument();
  });
});

function renderBoard(props: Partial<React.ComponentProps<typeof TradeBoard>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TradeBoard
        streamerId="s-1"
        scope="in_channel"
        isLoggedIn
        revealsUnownedCards
        filterCards={[
          { cardId: "card-a", name: "Card A" },
          { cardId: "card-b", name: "Card B" },
        ]}
        loginHref="/login"
        createHref="/trade/s-1/new"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe("TradeBoard", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // The board's page cache is module-level (shared across remounts).
    clearTradeListCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads offers from GET /api/trades (client side, rate limited) with scope", async () => {
    fetchMock.mockImplementation(async () => listResponse([makeOffer()]));
    renderBoard({ scope: "cross_channel", filterCards: [] });
    expect(await screen.findByText("Offered Dragon")).toBeInTheDocument();
    const url = new URL(fetchMock.mock.calls[0][0] as string, "https://x.test");
    expect(url.pathname).toBe("/api/trades");
    expect(url.searchParams.get("streamerId")).toBe("s-1");
    expect(url.searchParams.get("scope")).toBe("cross_channel");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("offers wanted/offered filters on the in-channel tab and sends them", async () => {
    fetchMock.mockImplementation(async () => listResponse([]));
    renderBoard();
    const wanted = await screen.findByLabelText(ja.filterWantedCard);
    fireEvent.change(wanted, { target: { value: "card-b" } });
    await waitFor(() => {
      const last = new URL(fetchMock.mock.calls.at(-1)![0] as string, "https://x.test");
      expect(last.searchParams.get("wantedCardId")).toBe("card-b");
    });
    expect(await screen.findByText(ja.emptyStateFiltered)).toBeInTheDocument();
  });

  it("has no card filter on the cross-channel tab (MVP)", async () => {
    fetchMock.mockImplementation(async () => listResponse([]));
    renderBoard({ scope: "cross_channel" });
    await screen.findByText(ja.emptyStateMessage);
    expect(screen.queryByLabelText(ja.filterWantedCard)).toBeNull();
  });

  it("shows the normal empty state with a create CTA", async () => {
    fetchMock.mockImplementation(async () => listResponse([]));
    renderBoard();
    expect(await screen.findByText(ja.emptyStateMessage)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ja.emptyStateCta })).toHaveAttribute("href", "/trade/s-1/new");
    expect(screen.queryByText(ja.unrevealedNotice)).toBeNull();
  });

  it("explains the owned-cards-only listing and uses a distinct empty state when unowned cards are hidden", async () => {
    fetchMock.mockImplementation(async () => listResponse([]));
    renderBoard({ revealsUnownedCards: false });
    expect(screen.getByText(ja.unrevealedNotice)).toBeInTheDocument();
    expect(await screen.findByText(ja.emptyStateUnrevealed)).toBeInTheDocument();
    expect(screen.queryByText(ja.emptyStateMessage)).toBeNull();
  });

  it("keeps the unrevealed notice above a non-empty list", async () => {
    fetchMock.mockImplementation(async () => listResponse([makeOffer()]));
    renderBoard({ revealsUnownedCards: false });
    expect(await screen.findByText("Offered Dragon")).toBeInTheDocument();
    expect(screen.getByText(ja.unrevealedNotice)).toBeInTheDocument();
  });

  it("shows an inline error banner with retry when loading fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { code: "RATE_LIMIT_EXCEEDED" }));
    fetchMock.mockResolvedValueOnce(listResponse([makeOffer()]));
    renderBoard();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(ja.loadError);
    fireEvent.click(within(alert).getByRole("button", { name: ja.retryButton }));
    expect(await screen.findByText("Offered Dragon")).toBeInTheDocument();
  });

  it("pages with hasMore", async () => {
    fetchMock.mockResolvedValueOnce(listResponse([makeOffer()], true));
    fetchMock.mockResolvedValueOnce(listResponse([makeOffer({ id: "offer-2" })], false));
    renderBoard();
    await screen.findByText("Offered Dragon");
    fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.next }));
    await waitFor(() => {
      const last = new URL(fetchMock.mock.calls.at(-1)![0] as string, "https://x.test");
      expect(last.searchParams.get("page")).toBe("2");
    });
  });

  it("keeps the same requestId for an offer across failed attempts and reopening, and refetches after success", async () => {
    const acceptBodies: string[] = [];
    let acceptCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/trades?")) return listResponse([makeOffer()]);
      if (url === "/api/trades/offer-1/accept") {
        acceptBodies.push(init!.body as string);
        acceptCalls += 1;
        return acceptCalls === 1
          ? jsonResponse(503, { code: "TRADE_BUSY" })
          : jsonResponse(200, { success: true });
      }
      throw new Error(`unexpected ${url}`);
    });
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: ja.acceptButton }));
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeBusy);
    // Close and reopen the same offer, then retry.
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalCancelButton }));
    fireEvent.click(screen.getByRole("button", { name: ja.acceptButton }));
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));
    expect(await screen.findByText(ja.confirmModalSuccess)).toBeInTheDocument();

    expect(acceptBodies).toHaveLength(2);
    const [first, second] = acceptBodies.map((body) => JSON.parse(body).requestId);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toBe(first);

    const listCallsBefore = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/trades?")).length;
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalCloseButton }));
    await waitFor(() => {
      const listCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/trades?")).length;
      expect(listCalls).toBe(listCallsBefore + 1);
    });
  });

  it("uses a different requestId for a different offer", async () => {
    const requestIds = new Map<string, string>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/trades?")) return listResponse([makeOffer(), makeOffer({ id: "offer-2" })]);
      const match = /\/api\/trades\/(offer-\d)\/accept/.exec(url);
      if (match) {
        requestIds.set(match[1], JSON.parse(init!.body as string).requestId);
        // Transient error: no refetch, so both rows stay on screen.
        return jsonResponse(503, { code: "TRADE_BUSY" });
      }
      throw new Error(`unexpected ${url}`);
    });
    renderBoard();
    const buttons = await screen.findAllByRole("button", { name: ja.acceptButton });
    fireEvent.click(buttons[0]);
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalCancelButton }));
    fireEvent.click(screen.getAllByRole("button", { name: ja.acceptButton })[1]);
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));
    await screen.findByRole("alert");
    expect(requestIds.get("offer-1")).toBeTruthy();
    expect(requestIds.get("offer-2")).toBeTruthy();
    expect(requestIds.get("offer-1")).not.toBe(requestIds.get("offer-2"));
  });

  it("shows the post-listing notice once and drops ?listed=1 from the URL", async () => {
    window.history.replaceState(null, "", "/trade/s-1?listed=1");
    fetchMock.mockImplementation(async () => listResponse([]));
    renderBoard({ justListed: true });
    expect(screen.getByText(ja.listedNotice)).toBeInTheDocument();
    expect(window.location.search).toBe("");
    await screen.findByText(ja.emptyStateMessage);
  });

  it("ignores a superseded (slow) response when the filter changes", async () => {
    let resolveFirst: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          resolveFirst = resolve;
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    fetchMock.mockImplementation(async () => listResponse([makeOffer({ id: "new", offeredCard: { name: "Filtered Card", rarity: "rare", imageUrl: null } })]));
    renderBoard();
    fireEvent.change(screen.getByLabelText(ja.filterOfferedCard), { target: { value: "card-a" } });
    expect(await screen.findByText("Filtered Card")).toBeInTheDocument();
    // The first request was aborted; even if its body arrives late it is not shown.
    resolveFirst(listResponse([makeOffer({ offeredCard: { name: "Stale Card", rarity: "rare", imageUrl: null } })]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale Card")).toBeNull();
    expect(screen.getByText("Filtered Card")).toBeInTheDocument();
  });

  it("returns focus to the row's accept button when the dialog is cancelled", async () => {
    fetchMock.mockImplementation(async () => listResponse([makeOffer()]));
    renderBoard();
    const accept = await screen.findByRole("button", { name: ja.acceptButton });
    fireEvent.click(accept);
    expect(screen.getByRole("button", { name: ja.confirmModalCancelButton })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalCancelButton }));
    await waitFor(() => expect(accept).toHaveFocus());
  });

  it("steps back a page when a later page became empty (e.g. last offer accepted)", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const page = new URL(url, "https://x.test").searchParams.get("page");
      return page === "1" ? listResponse([makeOffer()], true) : listResponse([]);
    });
    renderBoard();
    await screen.findByText("Offered Dragon");
    fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.next }));
    await waitFor(() => {
      const pages = fetchMock.mock.calls.map(([url]) => new URL(String(url), "https://x.test").searchParams.get("page"));
      expect(pages).toEqual(["1", "2", "1"]);
    });
    expect(await screen.findByText("Offered Dragon")).toBeInTheDocument();
    expect(screen.queryByText(ja.emptyStateMessage)).toBeNull();
  });

  it("uses a plain login link for the anonymous create CTA", async () => {
    fetchMock.mockImplementation(async () => listResponse([]));
    renderBoard({ isLoggedIn: false, createHref: "/api/auth/twitch/login?redirect=true&returnTo=%2Ftrade%2Fs-1%2Fnew" });
    expect(await screen.findByRole("link", { name: ja.emptyStateCta })).toHaveAttribute(
      "href",
      "/api/auth/twitch/login?redirect=true&returnTo=%2Ftrade%2Fs-1%2Fnew",
    );
  });

  it("refetches after TRADE_CARD_NOT_OWNED so the row's state is current", async () => {
    let listCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/trades?")) {
        listCalls += 1;
        return listResponse([makeOffer({ canAccept: listCalls === 1 ? "yes" : "not_owned" })]);
      }
      return jsonResponse(409, { code: "TRADE_CARD_NOT_OWNED" });
    });
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: ja.acceptButton }));
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalCancelButton }));
    expect(await screen.findByRole("button", { name: ja.acceptButtonNotOwned })).toBeDisabled();
  });

  describe("client cache (no refetch on page / tab switching)", () => {
    function listCallsFor(predicate: (query: URLSearchParams) => boolean) {
      return fetchMock.mock.calls.filter(([url]) => {
        if (!String(url).startsWith("/api/trades?")) return false;
        return predicate(new URL(String(url), "https://x.test").searchParams);
      }).length;
    }

    it("shows a page fetched before immediately when paging back, without a request", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        const page = new URL(url, "https://x.test").searchParams.get("page");
        return page === "1"
          ? listResponse([makeOffer()], true)
          : listResponse([makeOffer({ id: "offer-2", offeredCard: { name: "Page Two Card", rarity: "rare", imageUrl: null } })]);
      });
      renderBoard();
      await screen.findByText("Offered Dragon");
      fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.next }));
      await screen.findByText("Page Two Card");

      fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.previous }));
      expect(screen.getByText("Offered Dragon")).toBeInTheDocument();
      expect(screen.queryByText(ja.loading)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listCallsFor((query) => query.get("page") === "1")).toBe(1);
    });

    it("reuses pages across remounts (scope tab switch) for the same streamer and scope", async () => {
      fetchMock.mockImplementation(async (url: string) => {
        const scope = new URL(url, "https://x.test").searchParams.get("scope");
        return listResponse([makeOffer({ offeredCard: { name: `${scope} card`, rarity: "rare", imageUrl: null } })]);
      });
      const first = renderBoard();
      await screen.findByText("in_channel card");
      first.unmount();
      const cross = renderBoard({ scope: "cross_channel", filterCards: [] });
      await screen.findByText("cross_channel card");
      cross.unmount();

      renderBoard();
      expect(screen.getByText("in_channel card")).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listCallsFor((query) => query.get("scope") === "in_channel")).toBe(1);
    });

    it("refetches every page after clearTradeListCache() (e.g. a new listing elsewhere)", async () => {
      fetchMock.mockImplementation(async () => listResponse([makeOffer()]));
      const first = renderBoard();
      await screen.findByText("Offered Dragon");
      first.unmount();
      clearTradeListCache();
      renderBoard();
      expect(screen.getByText(ja.loading)).toBeInTheDocument();
      await screen.findByText("Offered Dragon");
      expect(listCallsFor(() => true)).toBe(2);
    });

    it("after a completed accept: removes the row at once and drops other cached pages", async () => {
      let releaseRefresh: () => void = () => {};
      const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      let listCalls = 0;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.startsWith("/api/trades?")) {
          listCalls += 1;
          const query = new URL(url, "https://x.test").searchParams;
          if (query.get("page") === "2") {
            return listResponse([makeOffer({ id: "offer-2", offeredCard: { name: "Page Two Card", rarity: "rare", imageUrl: null } })]);
          }
          // Hold the post-accept refresh of page 1.
          if (listCalls > 2) await refreshGate;
          return listResponse(listCalls > 2 ? [] : [makeOffer()], true);
        }
        if (url === "/api/trades/offer-1/accept") return jsonResponse(200, { success: true });
        throw new Error(`unexpected ${url}`);
      });
      renderBoard();
      await screen.findByText("Offered Dragon");
      fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.next }));
      await screen.findByText("Page Two Card");
      fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.previous }));
      expect(screen.getByText("Offered Dragon")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: ja.acceptButton }));
      fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));
      await screen.findByText(ja.confirmModalSuccess);
      fireEvent.click(screen.getByRole("button", { name: ja.confirmModalCloseButton }));
      expect(screen.queryByText("Offered Dragon")).toBeNull();
      releaseRefresh();
      await waitFor(() => expect(listCallsFor((query) => query.get("page") === "1")).toBe(2));

      // Page 2 was cached before the accept; it must be fetched again.
      fireEvent.click(screen.getByRole("button", { name: jaMessages.pagination.next }));
      await waitFor(() => expect(listCallsFor((query) => query.get("page") === "2")).toBe(2));
    });
  });
});

