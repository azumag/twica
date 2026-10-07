import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TradeBoard from "@/components/TradeBoard";
import type { TradeOfferDto } from "@/lib/trade";
import jaMessages from "../../../messages/ja.json";

const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

function makeOffer(overrides: Partial<TradeOfferDto> = {}): TradeOfferDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    offeredUserCardId: "22222222-2222-4222-8222-222222222222",
    offeredCardId: "33333333-3333-4333-8333-333333333333",
    offeredStreamerId: "streamer-1",
    wantedCardId: "44444444-4444-4444-8444-444444444444",
    wantedStreamerId: "streamer-1",
    offeredCard: { name: "もらえるカード", rarity: "SR", imageUrl: null },
    wantedCard: { name: "渡すカード", rarity: "R", imageUrl: null },
    isCrossChannel: false,
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    offerer: { twitchUsername: "seller_a", twitchDisplayName: "出品者A", twitchProfileImageUrl: null },
    offeredStreamer: null,
    wantedStreamer: null,
    isOwnOffer: false,
    canAccept: "yes",
    ...overrides,
  };
}

function mockList(offers: TradeOfferDto[], hasMore = false) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/trades?")) {
      return new Response(JSON.stringify({ offers, page: 1, pageSize: 20, hasMore }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function renderBoard(props: { crossChannelEnabled?: boolean; initialScope?: "in_channel" | "cross_channel" } = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TradeBoard
        streamerId="streamer-1"
        initialScope={props.initialScope ?? "in_channel"}
        crossChannelEnabled={props.crossChannelEnabled ?? true}
      />
    </NextIntlClientProvider>,
  );
}

describe("TradeBoard (#726)", () => {
  beforeEach(() => {
    replaceMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders offers with the accepter's perspective and the auto-select notice", async () => {
    const offer = makeOffer({
      offeredCard: { name: "もらえるカード", rarity: "SR", imageUrl: "https://example.com/a.png" },
      wantedCard: { name: "渡すカード", rarity: "R", imageUrl: "https://example.com/b.png" },
    });
    vi.stubGlobal("fetch", mockList([offer]));
    renderBoard();

    // 応諾者視点: もらえるカードが先に表示される
    expect(await screen.findByText("もらえるカード")).toBeTruthy();
    expect(screen.getByText("渡すカード")).toBeTruthy();
    expect(screen.getByText(jaMessages.trade.autoSelectNotice)).toBeTruthy();
    expect(screen.getByRole("button", { name: jaMessages.trade.acceptButton })).toBeTruthy();
  });

  it("disables the accept button for not_owned and all_listed states", async () => {
    vi.stubGlobal(
      "fetch",
      mockList([
        makeOffer({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", canAccept: "not_owned" }),
        makeOffer({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", canAccept: "all_listed" }),
      ]),
    );
    renderBoard();

    const notOwned = await screen.findByRole("button", { name: jaMessages.trade.acceptButtonNotOwned });
    expect((notOwned as HTMLButtonElement).disabled).toBe(true);
    const allListed = screen.getByRole("button", { name: jaMessages.trade.acceptButtonAllListed });
    expect((allListed as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a login link with returnTo when logged out (canAccept omitted)", async () => {
    vi.stubGlobal("fetch", mockList([makeOffer({ canAccept: undefined })]));
    renderBoard();

    const loginLink = await screen.findByRole("link", { name: jaMessages.trade.acceptButtonLoginRequired });
    expect(loginLink.getAttribute("href")).toContain(encodeURIComponent("/trade/streamer-1"));
  });

  it("shows the empty state when there are no offers", async () => {
    vi.stubGlobal("fetch", mockList([]));
    renderBoard();

    expect(await screen.findByText(jaMessages.trade.emptyStateMessage)).toBeTruthy();
  });

  it("shows an inline error banner with retry on list failure", async () => {
    const fetchMock = vi.fn(async () => new Response("ng", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    renderBoard();

    expect(await screen.findByText(jaMessages.trade.errorLoadFailed)).toBeTruthy();
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ offers: [], page: 1, pageSize: 20, hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: jaMessages.trade.retryButton }));
    await waitFor(() => expect(screen.getByText(jaMessages.trade.emptyStateMessage)).toBeTruthy());
  });

  it("hides the cross-channel tab when cross-channel trading is disabled", async () => {
    vi.stubGlobal("fetch", mockList([]));
    renderBoard({ crossChannelEnabled: false });

    await waitFor(() => expect(fetchMockCalled()).toBe(true));
    expect(screen.queryByRole("tab", { name: jaMessages.trade.tabCrossChannel })).toBeNull();
    expect(screen.getByRole("tab", { name: jaMessages.trade.tabInChannel })).toBeTruthy();
  });

  function fetchMockCalled() {
    return (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0;
  }

  it("switches scope with ?scope=cross and shows streamer badges", async () => {
    const crossOffer = makeOffer({
      isCrossChannel: true,
      offeredStreamer: { id: "streamer-a", twitchUsername: "a", twitchDisplayName: "配信者A", twitchProfileImageUrl: null },
      wantedStreamer: { id: "streamer-b", twitchUsername: "b", twitchDisplayName: "配信者B", twitchProfileImageUrl: null },
    });
    vi.stubGlobal("fetch", mockList([crossOffer]));
    renderBoard({ initialScope: "cross_channel" });

    expect(await screen.findByText(/配信者A/)).toBeTruthy();
    expect(screen.getByText(/配信者B/)).toBeTruthy();
  });

  it("opens the accept modal with cancel as the initial focus and closes on Escape", async () => {
    vi.stubGlobal("fetch", mockList([makeOffer()]));
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: jaMessages.trade.acceptButton }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // 初期フォーカスは非破壊的なキャンセルボタン
    expect(document.activeElement?.textContent).toBe(jaMessages.trade.confirmModalCancelButton);
    expect(screen.getByText(jaMessages.trade.confirmModalWarning)).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the same requestId across retries and shows the busy message on TRADE_BUSY", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/trades?")) {
          return new Response(JSON.stringify({ offers: [makeOffer()], page: 1, pageSize: 20, hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        bodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ error: "Trade processing is busy. Please try again" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: jaMessages.trade.acceptButton }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: jaMessages.trade.confirmModalSubmitButton }));
    expect(await within(dialog).findByText(jaMessages.trade.errorTradeBusy)).toBeTruthy();
    expect(bodies.length).toBe(1);

    // モーダル内でリトライ相当の再送信をしても requestId は同一
    const firstId = (JSON.parse(bodies[0]) as { requestId: string }).requestId;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows success and refetches the list after a completed trade", async () => {
    let acceptCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/trades?")) {
          return new Response(JSON.stringify({ offers: [makeOffer()], page: 1, pageSize: 20, hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        acceptCalls += 1;
        return new Response(
          JSON.stringify({ success: true, tradeOfferId: "11111111-1111-4111-8111-111111111111" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: jaMessages.trade.acceptButton }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: jaMessages.trade.confirmModalSubmitButton });
    // 送信中は disabled になる
    fireEvent.click(submit);
    expect(await within(dialog).findByText(jaMessages.trade.confirmModalSuccess)).toBeTruthy();
    expect(acceptCalls).toBe(1);

    // 閉じたら一覧を refetch する
    fireEvent.click(within(dialog).getByRole("button", { name: jaMessages.trade.modalCloseButton }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("maps a completed/invalid offer to the refetch message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/trades?")) {
          return new Response(JSON.stringify({ offers: [makeOffer()], page: 1, pageSize: 20, hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "Trade offer is no longer open" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: jaMessages.trade.acceptButton }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: jaMessages.trade.confirmModalSubmitButton }));
    expect(
      await within(dialog).findByText(jaMessages.trade.errorTradeAlreadyCompletedOrInvalid),
    ).toBeTruthy();
  });

  it("shows own offers with a badge instead of the accept button", async () => {
    vi.stubGlobal("fetch", mockList([makeOffer({ isOwnOffer: true })]));
    renderBoard();

    expect(await screen.findByText(jaMessages.trade.ownOfferBadge)).toBeTruthy();
    expect(screen.queryByRole("button", { name: jaMessages.trade.acceptButton })).toBeNull();
  });
});
