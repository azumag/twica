import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import TradeCancelModal from "@/components/TradeCancelModal";
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

function renderModal(props: Partial<React.ComponentProps<typeof TradeCancelModal>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <TradeCancelModal offer={makeOffer()} onConfirm={onConfirm} onClose={onClose} {...props} />
    </NextIntlClientProvider>,
  );
  return { ...utils, onConfirm, onClose };
}

/**
 * Cancel confirmation dialog (#1754 item 5): it replaces window.confirm, so
 * the dialog itself and its shared shell behavior are what these tests pin.
 */
describe("TradeCancelModal (#1754)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is an aria-modal dialog that names the offer being withdrawn", () => {
    renderModal();
    const dialog = screen.getByRole("dialog", { name: ja.cancelOfferConfirm });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(ja.cancelOfferModalWarning);
    // The viewer's own perspective: what they give ⇄ what they want.
    expect(screen.getByText("Offered Dragon")).toBeInTheDocument();
    expect(screen.getByText("Wanted Slime")).toBeInTheDocument();
    expect(screen.getByText(ja.myTradesGive)).toBeInTheDocument();
    expect(screen.getByText(ja.myTradesWant)).toBeInTheDocument();
  });

  it("puts initial focus on the dismiss button (not the irreversible action)", () => {
    renderModal();
    expect(screen.getByRole("button", { name: ja.cancelOfferModalDismissButton })).toHaveFocus();
  });

  it("calls onConfirm from the destructive button and onClose from dismiss", () => {
    const { onConfirm, onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: ja.cancelOfferModalConfirmButton }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: ja.cancelOfferModalDismissButton }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("requests a close on Escape", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab / Shift+Tab inside the dialog", () => {
    renderModal();
    const dismiss = screen.getByRole("button", { name: ja.cancelOfferModalDismissButton });
    const confirm = screen.getByRole("button", { name: ja.cancelOfferModalConfirmButton });

    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dismiss).toHaveFocus();

    dismiss.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    // Focus that escaped to the page is pulled back into the dialog.
    document.body.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dismiss).toHaveFocus();
  });

  it("locks background scrolling while open and restores it on unmount", () => {
    document.body.style.overflow = "auto";
    const { unmount } = renderModal();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("closes when the backdrop (not the dialog) is clicked", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
