import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TradeCreateForm from "@/components/TradeCreateForm";
import type { TradeableOwnedCopy, WantableCard } from "@/lib/trade";
import jaMessages from "../../../messages/ja.json";

const ja = jaMessages.trade;
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

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
  { cardId: "card-dup", name: "Dup Card", rarity: "common", imageUrl: null, isOwned: true },
  { cardId: "card-want", name: "Want Card", rarity: "epic", imageUrl: null, isOwned: false },
  { cardId: "card-want-2", name: "Want Card Two", rarity: "rare", imageUrl: null, isOwned: true },
];

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderForm(props: Partial<React.ComponentProps<typeof TradeCreateForm>> = {}) {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TradeCreateForm
        streamerId="s-1"
        cross={null}
        ownedCopies={OWNED}
        wantableCards={WANTABLE}
        wantableRevealsUnowned
        boardHref="/trade/s-1"
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

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/trade/s-1?listed=1"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/trades");
    const body = JSON.parse(init.body as string);
    expect(body.offeredUserCardId).toBe("uc-dup-mid");
    expect(body.wantedCardId).toBe("card-want-2");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
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
  ])("shows the inline copy for %s", async (code, status, text) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: "x", code }));
    renderForm();
    fireEvent.click(tile(step(ja.createStep1Title), "Single Card"));
    fireEvent.click(within(step(ja.createStep2Title)).getByRole("button", { name: /Want Card Two/ }));
    fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(push).not.toHaveBeenCalled();
  });

  it("cross-channel: lists partner channels as links and hides Step 2 cards until one is chosen", () => {
    renderForm({
      cross: {
        partners: [
          { id: "s-2", twitchDisplayName: "PartnerTwo", twitchProfileImageUrl: null },
          { id: "s-3", twitchDisplayName: "PartnerThree", twitchProfileImageUrl: null },
        ],
        selectedPartnerId: null,
      },
      wantableCards: [],
      boardHref: "/trade/s-1?scope=cross",
    });
    expect(screen.getByText(ja.createStep2SelectStreamer)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PartnerTwo" })).toHaveAttribute(
      "href",
      "/trade/s-1/new?scope=cross&partner=s-2",
    );
    expect(screen.queryByText(ja.createStep2Empty)).toBeNull();
  });

  it("cross-channel: carries the Step 1 choice over the partner navigation", () => {
    renderForm({
      cross: {
        partners: [{ id: "s-2", twitchDisplayName: "PartnerTwo", twitchProfileImageUrl: null }],
        selectedPartnerId: null,
      },
      wantableCards: [],
    });
    fireEvent.click(tile(step(ja.createStep1Title), "Single Card"));
    expect(screen.getByRole("link", { name: "PartnerTwo" })).toHaveAttribute(
      "href",
      "/trade/s-1/new?scope=cross&partner=s-2&offered=card-single",
    );
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

  it("cross-channel: marks the chosen partner and redirects to the cross board after listing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { tradeOffer: { id: "o-1" } }));
    renderForm({
      cross: {
        partners: [{ id: "s-2", twitchDisplayName: "PartnerTwo", twitchProfileImageUrl: null }],
        selectedPartnerId: "s-2",
      },
      wantableCards: [{ cardId: "p-card", name: "Partner Card", rarity: "rare", imageUrl: null, isOwned: false }],
      boardHref: "/trade/s-1?scope=cross",
    });
    expect(screen.getByRole("link", { name: "PartnerTwo" })).toHaveAttribute("aria-current", "true");
    fireEvent.click(tile(step(ja.createStep1Title), "Single Card"));
    fireEvent.click(within(step(ja.createStep2Title)).getByRole("button", { name: /Partner Card/ }));
    fireEvent.click(screen.getByRole("button", { name: ja.createSubmitButton }));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/trade/s-1?scope=cross&listed=1"));
  });

  it("explains when no partner channel is available", () => {
    renderForm({ cross: { partners: [], selectedPartnerId: null }, wantableCards: [] });
    expect(screen.getByText(ja.createStep2NoPartners)).toBeInTheDocument();
  });

  it("explains when the viewer has nothing to give", () => {
    renderForm({ ownedCopies: [] });
    expect(screen.getByText(ja.createStep1Empty)).toBeInTheDocument();
  });
});
