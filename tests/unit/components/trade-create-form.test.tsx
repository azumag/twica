import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import TradeCreateForm from "@/components/TradeCreateForm";
import type { TradeableOwnedCopy, WantableCard } from "@/lib/trade";
import jaMessages from "../../../messages/ja.json";
import enMessages from "../../../messages/en.json";

const ja = jaMessages.trade;
const trEn = createTranslator({ locale: "en", messages: enMessages, namespace: "trade" });
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
const clearTradeListCache = vi.hoisted(() => vi.fn());
vi.mock("@/lib/use-trade-list", () => ({ clearTradeListCache }));

function copy(overrides: Partial<TradeableOwnedCopy>): TradeableOwnedCopy {
  return {
    userCardId: "uc-x",
    cardId: "card-x",
    name: "Card X",
    rarity: "common",
    imageUrl: null,
    obtainedAt: "2026-01-01T00:00:00.000Z",
    isListed: false,
    ownedCount: 1,
    ...overrides,
  };
}

// Server order: rarity/name, then obtained_at ASC within a card.
const OWNED: TradeableOwnedCopy[] = [
  copy({ userCardId: "uc-single", cardId: "card-single", name: "Single Card", ownedCount: 1 }),
  copy({ userCardId: "uc-listed", cardId: "card-listed", name: "Listed Card", ownedCount: 1, isListed: true }),
  copy({ userCardId: "uc-dup-old", cardId: "card-dup", name: "Dup Card", ownedCount: 3, isListed: true }),
  copy({ userCardId: "uc-dup-mid", cardId: "card-dup", name: "Dup Card", ownedCount: 3 }),
  copy({ userCardId: "uc-dup-new", cardId: "card-dup", name: "Dup Card", ownedCount: 3 }),
];

const WANTABLE: WantableCard[] = [
  { cardId: "card-dup", name: "Dup Card", rarity: "common", imageUrl: null, collectionNumber: 1, isOwned: true },
  { cardId: "card-want", name: "Want Card", rarity: "epic", imageUrl: null, collectionNumber: 2, isOwned: false },
  { cardId: "card-want-2", name: "Want Card Two", rarity: "rare", imageUrl: null, collectionNumber: 3, isOwned: true },
];

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderForm(
  props: Partial<React.ComponentProps<typeof TradeCreateForm>> = {},
  locale: "ja" | "en" = "ja",
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "ja" ? jaMessages : enMessages}>
      <TradeCreateForm
        kind="offer"
        ownedCopies={OWNED}
        wantableCards={WANTABLE}
        wantableRevealsUnowned
        wantableRevealsUnownedImages
        maxWantedQuantity={10}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

function step(name: string) {
  return screen.getByRole("region", { name });
}

function tile(region: HTMLElement, cardName: string) {
  return within(region).getByRole("button", { name: new RegExp(cardName) });
}

describe("TradeCreateForm (#727 §6.5)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    push.mockReset();
    clearTradeListCache.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Step 1 groups copies per card, greys out fully listed cards and badges duplicates first", () => {
    renderForm();
    const step1 = step(ja.createStep1Title);
    const buttons = within(step1).getAllByRole("button");
    // Duplicate with a listable copy is recommended first; then server order.
    expect(buttons[0]).toHaveTextContent("Dup Card");
    expect(buttons[0]).toHaveTextContent("×3");
    expect(buttons[0]).toHaveTextContent("出品中 1枚");
    expect(buttons[0]).toBeEnabled();

    const listed = tile(step1, "Listed Card");
    expect(listed).toBeDisabled();
    expect(listed).toHaveTextContent(ja.createStep1ListedBadge);
    expect(tile(step1, "Single Card")).toBeEnabled();
    expect(tile(step1, "Single Card")).not.toHaveTextContent("×");
  });

  it("Step 2 lists only the server-provided candidates, marks unowned ones and blocks the same card", () => {
    renderForm();
    const step2 = step(ja.createStep2Title);
    expect(within(step2).getAllByRole("button")).toHaveLength(WANTABLE.length);
    expect(within(step2).getByRole("button", { name: /Want Card(?! Two)/ })).toHaveTextContent(ja.createStep2UnownedBadge);
    expect(within(step2).getByRole("button", { name: /Want Card Two/ })).not.toHaveTextContent(ja.createStep2UnownedBadge);

    fireEvent.click(tile(step(ja.createStep1Title), "Dup Card"));
    expect(within(step2).getByRole("button", { name: /Dup Card/ })).toBeDisabled();
  });

  it("shows the owned-only notice when the wanted channel hides unowned cards", () => {
    renderForm({ wantableRevealsUnowned: false });
    expect(screen.getByText(ja.createStep2UnrevealedNotice)).toBeInTheDocument();
  });

  it("explains that a name-only channel lists unowned cards without images (#2070)", () => {
    renderForm({ wantableRevealsUnowned: true, wantableRevealsUnownedImages: false });
    expect(screen.getByText(ja.createStep2NameOnlyNotice)).toBeInTheDocument();
    expect(screen.queryByText(ja.createStep2UnrevealedNotice)).not.toBeInTheDocument();
  });

  it("does not show the name-only notice when images are public too", () => {
    renderForm({ wantableRevealsUnowned: true, wantableRevealsUnownedImages: true });
    expect(screen.queryByText(ja.createStep2NameOnlyNotice)).not.toBeInTheDocument();
  });

  it("confirms and POSTs the oldest unlisted copy with the selection-bound requestId", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { tradeOffer: { id: "o-1" } }));
    renderForm();
    const submit = screen.getByRole("button", { name: ja.createSubmitButton });
    expect(submit).toBeDisabled();
    expect(screen.getByText(ja.createConfirmPending)).toBeInTheDocument();

    fireEvent.click(tile(step(ja.createStep1Title), "Dup Card"));
    fireEvent.click(within(step(ja.createStep2Title)).getByRole("button", { name: /Want Card Two/ }));
    expect(screen.getByText("渡す Dup Card ⇄ 欲しい Want Card Two で出品します")).toBeInTheDocument();
    fireEvent.click(submit);

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/trade?listed=offer"));
    // The board's cached pages predate the new offer: dropped before navigating.
    expect(clearTradeListCache).toHaveBeenCalledTimes(1);
    expect(clearTradeListCache.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/trades");
    const body = JSON.parse(init.body as string);
    expect(body.offeredUserCardId).toBe("uc-dup-mid");
    expect(body.wantedCardId).toBe("card-want-2");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // #1789: an untouched quantity selector posts the classic 1:1 offer.
    expect(body.wantedQuantity).toBe(1);
  });

  it("reuses the requestId when retrying the same selection and regenerates it when the selection changes", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(503, { code: "TRADE_BUSY" }));
    renderForm();
    const step1 = step(ja.createStep1Title);
    const step2 = step(ja.createStep2Title);
    const submit = () => fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
    const lastRequestId = () => JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string).requestId;

    fireEvent.click(tile(step1, "Single Card"));
    fireEvent.click(within(step2).getByRole("button", { name: /Want Card Two/ }));
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeBusy);
    const first = lastRequestId();

    submit();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: ja.createSubmitButton });
    expect(lastRequestId()).toBe(first);

    // Change the wanted card → new key.
    fireEvent.click(within(step2).getByRole("button", { name: /Want Card(?! Two)/ }));
    submit();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await screen.findByRole("button", { name: ja.createSubmitButton });
    const second = lastRequestId();
    expect(second).not.toBe(first);

    // Change the offered card → new key again.
    fireEvent.click(tile(step1, "Dup Card"));
    submit();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await screen.findByRole("button", { name: ja.createSubmitButton });
    expect(lastRequestId()).not.toBe(second);
  });

  it.each([
    ["TRADE_OFFER_LIMIT", 409, ja.errorTradeOfferLimit],
    ["TRADE_DISABLED", 403, ja.errorTradeDisabled],
    ["TRADE_CARD_ALREADY_LISTED", 409, ja.errorTradeCardAlreadyListed],
    ["TRADE_WANTED_CARD_UNAVAILABLE", 400, ja.errorTradeWantedCardUnavailable],
    // #1790: the form was opened before the streamer made the card non-wantable.
    ["TRADE_WANTED_CARD_NOT_WANTABLE", 409, ja.errorTradeWantedCardNotWantable],
  ])("shows the inline copy for %s", async (code, status, text) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: "x", code }));
    renderForm();
    fireEvent.click(tile(step(ja.createStep1Title), "Single Card"));
    fireEvent.click(within(step(ja.createStep2Title)).getByRole("button", { name: /Want Card Two/ }));
    fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(push).not.toHaveBeenCalled();
    expect(clearTradeListCache).not.toHaveBeenCalled();
  });

  it("preselects initialOfferedCardId only when it is a listable card", () => {
    renderForm({ initialOfferedCardId: "card-single" });
    expect(tile(step(ja.createStep1Title), "Single Card")).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores an initialOfferedCardId whose copies are all listed", () => {
    renderForm({ initialOfferedCardId: "card-listed" });
    expect(tile(step(ja.createStep1Title), "Listed Card")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(ja.createConfirmPending)).toBeInTheDocument();
  });

  it("explains when the viewer has nothing to give", () => {
    renderForm({ ownedCopies: [] });
    expect(screen.getByText(ja.createStep1Empty)).toBeInTheDocument();
  });

  describe("wanted quantity (#1789)", () => {
    const quantitySelect = () => within(step(ja.createStep2Title)).getByRole("combobox");
    const select = (cardTile: string, wantedTile: RegExp) => {
      fireEvent.click(tile(step(ja.createStep1Title), cardTile));
      fireEvent.click(within(step(ja.createStep2Title)).getByRole("button", { name: wantedTile }));
    };
    const bodyOf = (call: number) => JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);

    it("offers 1..maxWantedQuantity (default 1) with the localized label", () => {
      renderForm({ maxWantedQuantity: 4 });
      const el = quantitySelect();
      expect(within(step(ja.createStep2Title)).getByText(ja.createStep2QuantityLabel)).toBeInTheDocument();
      expect(el).toHaveValue("1");
      expect(within(el).getAllByRole("option").map((option) => option.textContent)).toEqual(
        ["1枚", "2枚", "3枚", "4枚"],
      );
    });

    it.each(["ja", "en"] as const)("exposes the unit in every %s option's text and accessible name", (locale) => {
      renderForm({}, locale);
      const messages = locale === "ja" ? jaMessages : enMessages;
      const el = screen.getByRole("combobox", { name: messages.trade.createStep2QuantityLabel });
      const options = within(el).getAllByRole("option");
      expect(options).toHaveLength(10);
      expect(el).toHaveValue("1");

      options.forEach((option, index) => {
        const count = index + 1;
        const name = locale === "ja" ? `${count}枚` : `${count} ${count === 1 ? "copy" : "copies"}`;
        expect(option).toHaveTextContent(name);
        expect(option).toHaveAccessibleName(name);
        // The readable unit is presentation only; selected/posted values stay numeric.
        expect(option).toHaveAttribute("value", String(count));
      });
    });

    it("is hidden while there is nothing to pick", () => {
      renderForm({ wantableCards: [] });
      expect(screen.getByText(ja.createStep2Empty)).toBeInTheDocument();
      expect(screen.queryByRole("combobox")).toBeNull();
    });

    it("posts the selected quantity and confirms it in the multiple summary", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { tradeOffer: { id: "o-1", wantedQuantity: 3 } }));
      renderForm();
      select("Dup Card", /Want Card Two/);
      // 1:1 keeps the classic summary.
      expect(screen.getByText("渡す Dup Card ⇄ 欲しい Want Card Two で出品します")).toBeInTheDocument();

      fireEvent.change(quantitySelect(), { target: { value: "3" } });
      expect(
        screen.getByText(
          ja.createConfirmSummaryMultiple
            .replace("{offeredCard}", "Dup Card")
            .replace("{wantedCard}", "Want Card Two")
            .replace("{count}", "3"),
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("渡す Dup Card ⇄ 欲しい Want Card Two で出品します")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
      await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/trade?listed=offer"));
      expect(bodyOf(0)).toMatchObject({
        offeredUserCardId: "uc-dup-mid",
        wantedCardId: "card-want-2",
        wantedQuantity: 3,
      });
    });

    describe("rollback to a server that ignores wantedQuantity (#1792 item 1)", () => {
      const submit = () => fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));

      it.each([
        ["omits wantedQuantity (pre-#1789 response shape)", { id: "o-1" }],
        ["stores a different quantity", { id: "o-1", wantedQuantity: 1 }],
      ])("does not report success when the server %s: shows the cancel guidance and stays on the form", async (_label, tradeOffer) => {
        fetchMock.mockResolvedValue(jsonResponse(200, { tradeOffer }));
        renderForm();
        select("Single Card", /Want Card Two/);
        fireEvent.change(quantitySelect(), { target: { value: "3" } });

        submit();

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(ja.errorTradeQuantityMismatch.replace("{requested}", "3").replace("{stored}", "1"));
        expect(alert).toHaveTextContent("マイトレード");
        expect(push).not.toHaveBeenCalled();
        // An offer exists now, so the cached board / my-trades pages are stale.
        expect(clearTradeListCache).toHaveBeenCalled();
        // The form is usable again (not stuck in "submitting").
        expect(screen.getByRole("button", { name: ja.createSubmitButton })).toBeEnabled();
      });

      it("uses the English guidance in the en locale", async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, { tradeOffer: { id: "o-1" } }));
        renderForm({}, "en");
        const en = enMessages.trade;
        fireEvent.click(within(screen.getByRole("region", { name: en.createStep1Title })).getByRole("button", { name: /Single Card/ }));
        fireEvent.click(within(screen.getByRole("region", { name: en.createStep2Title })).getByRole("button", { name: /Want Card Two/ }));
        fireEvent.change(screen.getByRole("combobox", { name: en.createStep2QuantityLabel }), { target: { value: "2" } });

        fireEvent.click(screen.getByRole("button", { name: en.createSubmitButton }));

        // The English wording renders the stored/requested counts through ICU
        // plurals, so a count of 1 must come out as "1 copy" (never "1 copies").
        expect(await screen.findByRole("alert")).toHaveTextContent(
          trEn("errorTradeQuantityMismatch", { requested: 2, stored: 1 }),
        );
        expect(push).not.toHaveBeenCalled();
      });

      it("keeps the normal success path for a 1:1 offer on an old server (absent means one copy)", async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, { tradeOffer: { id: "o-1" } }));
        renderForm();
        select("Single Card", /Want Card Two/);

        submit();

        await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/trade?listed=offer"));
        expect(screen.queryByRole("alert")).toBeNull();
      });
    });

    it("sends a number (not the select's string value)", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { tradeOffer: { id: "o-1", wantedQuantity: 10 } }));
      renderForm();
      select("Single Card", /Want Card Two/);
      fireEvent.change(quantitySelect(), { target: { value: "10" } });
      fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(bodyOf(0).wantedQuantity).toBe(10);
    });

    it("reuses the requestId for the same quantity and issues a new one when the quantity changes", async () => {
      fetchMock.mockImplementation(async () => jsonResponse(503, { code: "TRADE_BUSY" }));
      renderForm();
      const submit = () => fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
      const idOf = (call: number) => bodyOf(call).requestId;
      const settle = () => screen.findByRole("button", { name: ja.createSubmitButton });

      select("Single Card", /Want Card Two/);
      fireEvent.change(quantitySelect(), { target: { value: "3" } });
      submit();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await settle();

      // Retrying the identical selection (same quantity) replays the same key.
      submit();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      await settle();
      expect(idOf(1)).toBe(idOf(0));

      // Only the quantity changes → a different offer → a new key, otherwise
      // the server would replay the old ×3 offer instead of creating ×2.
      fireEvent.change(quantitySelect(), { target: { value: "2" } });
      submit();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      await settle();
      expect(bodyOf(2).wantedQuantity).toBe(2);
      expect(idOf(2)).not.toBe(idOf(0));

      // Going back to the first quantity is still a fresh key (the ref holds
      // only the latest selection), never the stale one.
      fireEvent.change(quantitySelect(), { target: { value: "3" } });
      submit();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
      expect(bodyOf(3).wantedQuantity).toBe(3);
      expect(idOf(3)).not.toBe(idOf(2));
    });

    it("clears a previous error when the quantity changes and is disabled while submitting", async () => {
      let resolveFetch: (value: Response) => void = () => {};
      fetchMock
        .mockImplementationOnce(async () => jsonResponse(503, { code: "TRADE_BUSY" }))
        .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
      renderForm();
      select("Single Card", /Want Card Two/);
      fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
      expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeBusy);

      fireEvent.change(quantitySelect(), { target: { value: "2" } });
      expect(screen.queryByRole("alert")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
      await vi.waitFor(() => expect(quantitySelect()).toBeDisabled());
      resolveFetch(jsonResponse(503, { code: "TRADE_BUSY" }));
      await vi.waitFor(() => expect(quantitySelect()).toBeEnabled());
    });
  });
});

describe("TradeCreateForm kind and auction (#1791, #2080)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    push.mockReset();
    clearTradeListCache.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const durationRadio = (name: string) => screen.getByRole("radio", { name });
  const auctionSubmit = () => screen.getByRole("button", { name: ja.createAuctionSubmitButton });

  it("offer kind: shows the card and wanted-card steps, with no kind switch or partner picker", () => {
    renderForm({ kind: "offer" });
    expect(screen.getByRole("region", { name: ja.createStep1Title })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: ja.createStep2Title })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: ja.createAuctionStep2Title })).toBeNull();
    // #2080: the kind and the counterpart channel are decided by /trade/new.
    // No kind radios are left, and the only link is the back link to the hub.
    expect(screen.queryByRole("radio")).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/trade");
    expect(links[0]).toHaveTextContent(ja.createFlowBackToHub);
  });

  it("auction kind: shows the card and deadline steps, with no kind switch or partner picker", () => {
    renderForm({ kind: "auction" });
    expect(screen.getByRole("region", { name: ja.createAuctionStep1Title })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: ja.createStep2Title })).toBeNull();
    const deadline = screen.getByRole("group", { name: ja.createAuctionStep2Title });
    // Only the three duration radios remain: no kind radios, no partner links.
    expect(
      within(deadline)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("value")),
    ).toEqual(["24", "72", "168"]);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(auctionSubmit()).toBeDisabled();
  });

  it("requires both a card and an explicit deadline, then POSTs the auction and returns to the hub", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { auction: { id: "a-1" }, idempotentReplay: false }));
    renderForm({ kind: "auction" });
    expect(screen.getByText(ja.createAuctionConfirmPending)).toBeInTheDocument();
    fireEvent.click(tile(step(ja.createAuctionStep1Title), "Dup Card"));
    expect(auctionSubmit()).toBeDisabled();
    fireEvent.click(durationRadio(ja.createAuctionDuration3d));
    expect(
      screen.getByText(`Dup Card を期限 ${ja.createAuctionDuration3d} のオークションに出品します`),
    ).toBeInTheDocument();
    fireEvent.click(auctionSubmit());

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/trade?listed=auction"));
    expect(clearTradeListCache).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/trades/auctions");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ offeredUserCardId: "uc-dup-mid", durationHours: 72 });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).not.toHaveProperty("wantedCardId");
  });

  it("reuses the requestId for the same card + deadline and issues a new one when the deadline changes", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(503, { code: "TRADE_BUSY" }));
    renderForm({ kind: "auction" });
    fireEvent.click(tile(step(ja.createAuctionStep1Title), "Single Card"));
    fireEvent.click(durationRadio(ja.createAuctionDuration24h));
    fireEvent.click(auctionSubmit());
    await screen.findByText(ja.errorTradeBusy);
    fireEvent.click(auctionSubmit());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(auctionSubmit()).toBeEnabled());
    fireEvent.click(durationRadio(ja.createAuctionDuration7d));
    fireEvent.click(auctionSubmit());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const ids = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).requestId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string).durationHours).toBe(168);
  });

  it("shows the API copy on failure, e.g. the shared open limit or the deploy window", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(409, { code: "TRADE_OFFER_LIMIT" }))
      .mockResolvedValueOnce(jsonResponse(503, { code: "TRADE_AUCTION_UNAVAILABLE" }));
    renderForm({ kind: "auction" });
    fireEvent.click(tile(step(ja.createAuctionStep1Title), "Single Card"));
    fireEvent.click(durationRadio(ja.createAuctionDuration24h));
    fireEvent.click(auctionSubmit());
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorTradeOfferLimit);
    fireEvent.click(auctionSubmit());
    await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(ja.errorTradeAuctionUnavailable));
    expect(push).not.toHaveBeenCalled();
  });

  it("disables the submit button while the auction request is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    renderForm({ kind: "auction" });
    fireEvent.click(tile(step(ja.createAuctionStep1Title), "Single Card"));
    fireEvent.click(durationRadio(ja.createAuctionDuration24h));
    fireEvent.click(auctionSubmit());
    const busy = screen.getByRole("button", { name: ja.createSubmitting });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(503, { code: "TRADE_BUSY" }));
    await vi.waitFor(() => expect(auctionSubmit()).toBeEnabled());
  });

});
