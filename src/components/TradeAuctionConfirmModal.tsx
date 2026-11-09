"use client";

import { useId, useRef } from "react";
import { useTranslations } from "next-intl";
import TradeDialog from "./TradeDialog";

interface TradeAuctionConfirmModalProps {
  title: string;
  /** What will happen (shown highlighted, announced as the description). */
  warning: string;
  confirmLabel: string;
  /** Red confirm button for an action that gives up something (cancel / withdraw). */
  destructive?: boolean;
  /** The viewer confirmed: the caller performs the request. */
  onConfirm: () => void;
  /** Escape / backdrop / dismiss: close without doing anything. */
  onClose: () => void;
  /** Summary of what is affected (card tiles). */
  children?: React.ReactNode;
}

/**
 * Confirmation dialog for the auction actions (#1791): withdraw a bid,
 * cancel an auction, settle with a bid.
 *
 * Same contract as <TradeCancelModal>: the shared <TradeDialog> shell (focus
 * trap, Escape, backdrop), initial focus on the dismiss button because every
 * one of these actions is irreversible, and no request inside the dialog —
 * the caller owns the busy state, the notices and the requestId, exactly like
 * /trade/mine's cancel flow. One generic dialog instead of three copies,
 * since only the texts differ.
 */
export default function TradeAuctionConfirmModal({
  title,
  warning,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose,
  children,
}: TradeAuctionConfirmModalProps) {
  const t = useTranslations("trade");
  const titleId = useId();
  const warningId = useId();
  const dismissRef = useRef<HTMLButtonElement>(null);

  return (
    <TradeDialog labelId={titleId} descriptionId={warningId} onClose={onClose} initialFocusRef={dismissRef}>
      <h2 id={titleId} className="mb-4 text-lg font-bold">
        {title}
      </h2>
      {children}
      <p id={warningId} className="mt-4 rounded-lg border border-yellow-600/60 bg-yellow-900/30 p-3 text-sm text-yellow-100">
        {warning}
      </p>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          ref={dismissRef}
          type="button"
          onClick={onClose}
          className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        >
          {t("cancelOfferModalDismissButton")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={`rounded-lg px-4 py-2 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 ${
            destructive
              ? "bg-red-700 hover:bg-red-600 focus-visible:ring-red-400"
              : "bg-purple-600 hover:bg-purple-700 focus-visible:ring-purple-400"
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </TradeDialog>
  );
}
