import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TradeAcceptModal from "@/components/TradeAcceptModal";
import type { TradeOfferDto } from "@/lib/trade";
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
    offeredStreamer: null,
    wantedStreamer: null,
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

function renderModal(props: Partial<React.ComponentProps<typeof TradeAcceptModal>> = {}) {
  const onClose = vi.fn();
  const onCompleted = vi.fn();
  const utils = render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TradeAcceptModal
        offer={makeOffer()}
        requestId="11111111-1111-4111-8111-111111111111"
        writeBlocked={false}
        onCompleted={onCompleted}
        onClose={onClose}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return { ...utils, onClose, onCompleted };
}

describe("TradeAcceptModal (#726 §6.4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is an aria-modal dialog showing both cards and the irreversibility warning", () => {
    renderModal();
    const dialog = screen.getByRole("dialog", { name: ja.confirmModalTitle });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Wanted Slime")).toBeInTheDocument();
    expect(screen.getByText("Offered Dragon")).toBeInTheDocument();
    expect(screen.getByText(ja.confirmModalWarning)).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(ja.confirmModalWarning);
    expect(screen.getByText(ja.confirmModalGiveLabel)).toBeInTheDocument();
    expect(screen.getByText(ja.confirmModalReceiveLabel)).toBeInTheDocument();
  });

  it("locks background scrolling while open and restores it on unmount", () => {
    document.body.style.overflow = "auto";
    const { unmount } = renderModal();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("puts initial focus on Cancel (not the irreversible submit)", () => {
    renderModal();
    expect(screen.getByRole("button", { name: ja.confirmModalCancelButton })).toHaveFocus();
  });

  it("traps Tab / Shift+Tab inside the dialog", () => {
    renderModal();
    const cancel = screen.getByRole("button", { name: ja.confirmModalCancelButton });
    const submit = screen.getByRole("button", { name: ja.confirmModalSubmitButton });

    submit.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();

    cancel.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(submit).toHaveFocus();

    // Focus that escaped to the page is pulled back into the dialog.
    document.body.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(cancel).toHaveFocus();
  });

  it("closes on Escape without refetching", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith({ refetch: false });
  });

  it("disables both buttons with a loading label while submitting and ignores Escape", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })),
    );
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));

    const submitting = await screen.findByRole("button", { name: ja.confirmModalSubmitting });
    expect(submitting).toBeDisabled();
    expect(submitting).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: ja.confirmModalCancelButton })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch(jsonResponse(200, { success: true }));
    });
    expect(await screen.findByText(ja.confirmModalSuccess)).toBeInTheDocument();
  });

  it("posts the given requestId and shows the received card on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { success: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { onCompleted, onClose } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));

    expect(await screen.findByRole("heading", { name: ja.confirmModalSuccess })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trades/offer-1/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ requestId: "11111111-1111-4111-8111-111111111111" }),
      }),
    );
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(screen.getByText(ja.confirmModalReceivedLabel)).toBeInTheDocument();
    expect(screen.getByText("Offered Dragon")).toBeInTheDocument();
    expect(screen.getByText(ja.collectionDelayNotice)).toBeInTheDocument();
    const close = screen.getByRole("button", { name: ja.confirmModalCloseButton });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith({ refetch: true });
  });

  it.each([
    // code, status, copy, offer gone (no re-submit), list stale (refetch on close)
    ["TRADE_OFFER_NOT_OPEN", 409, ja.errorTradeAlreadyCompletedOrInvalid, true, true],
    ["TRADE_OFFER_INVALID", 409, ja.errorTradeAlreadyCompletedOrInvalid, true, true],
    ["TRADE_OFFER_UNAVAILABLE", 409, ja.errorTradeOfferUnavailable, true, true],
    ["TRADE_OFFER_NOT_FOUND", 404, ja.errorTradeOfferNotFound, true, true],
    ["TRADE_BUSY", 503, ja.errorTradeBusy, false, false],
    ["TRADE_CARD_NOT_OWNED", 409, ja.errorTradeCardNotOwned, false, true],
    ["TRADE_DISABLED", 403, ja.errorTradeDisabled, false, true],
    ["TRADE_SELF_ACCEPT", 400, ja.errorTradeSelfAccept, false, false],
    ["RATE_LIMIT_EXCEEDED", 429, ja.errorRateLimited, false, false],
    ["SOMETHING_UNKNOWN", 500, ja.errorGeneric, false, false],
  ])("shows the copy for %s inline, blocks re-submit when gone and refetches when stale", async (code, status, text, gone, stale) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status, { error: "x", code })));
    const { onClose, onCompleted } = renderModal();

    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(onCompleted).not.toHaveBeenCalled();
    // A gone offer cannot be accepted any more: re-submitting is disabled.
    expect(screen.getByRole("button", { name: ja.confirmModalSubmitButton })).toHaveProperty("disabled", gone);

    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalCancelButton }));
    expect(onClose).toHaveBeenCalledWith({ refetch: stale });
  });

  it("shows the network error copy when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ja.errorNetwork);
  });

  it("does not send while maintenance blocks writes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderModal({ writeBlocked: true });
    fireEvent.click(screen.getByRole("button", { name: ja.confirmModalSubmitButton }));
    expect(await screen.findByRole("alert")).toHaveTextContent(jaMessages.maintenance.writeDisabled);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
