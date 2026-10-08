"use client";

import { useId, useRef } from "react";
import { useTranslations } from "next-intl";
import type { TradeOfferDto } from "@/lib/trade";
import { viewerSides } from "@/lib/trade-client";
import TradeCardSummary from "./TradeCardSummary";
import TradeDialog from "./TradeDialog";

interface TradeCancelModalProps {
  /** The viewer's own open offer (mineRole === "offerer"). */
  offer: TradeOfferDto;
  /** The viewer confirmed: the caller performs the cancel request. */
  onConfirm: () => void;
  /** Escape / backdrop / dismiss: close without cancelling. */
  onClose: () => void;
}

/**
 * Cancel confirmation dialog (§6.6, #1754 item 5).
 *
 * Replaces the browser-native window.confirm so that withdrawing an offer uses
 * the same in-app dialog as accepting one (<TradeDialog> shell, same focus
 * trap and initial focus rule); the native confirm cannot show which offer is
 * being withdrawn, cannot be styled, and ignores the app's locale plumbing.
 *
 * The dialog performs no request itself: the caller owns the row state
 * (cancellingId, notices) exactly like the rest of /trade/mine, so the row's
 * button keeps showing "cancelling" while the POST is in flight. Initial focus
 * is the dismiss button — cancelling an offer cannot be undone.
 */
export default function TradeCancelModal({ offer, onConfirm, onClose }: TradeCancelModalProps) {
  const t = useTranslations("trade");
  const titleId = useId();
  const warningId = useId();
  const dismissRef = useRef<HTMLButtonElement>(null);
  const { give, get } = viewerSides(offer);

  return (
    <TradeDialog
      labelId={titleId}
      descriptionId={warningId}
      onClose={onClose}
      initialFocusRef={dismissRef}
    >
      <h2 id={titleId} className="mb-4 text-lg font-bold">
        {t("cancelOfferConfirm")}
      </h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <TradeCardSummary card={give.card} deleted={give.deleted} label={t("myTradesGive")} />
        </div>
        <span
          role="img"
          aria-label={t("directionIconLabel")}
          className="self-center text-2xl text-purple-300 max-sm:rotate-90"
        >
          ⇄
        </span>
        <div className="min-w-0 flex-1">
          <TradeCardSummary card={get.card} deleted={get.deleted} label={t("myTradesWant")} />
        </div>
      </div>
      <p id={warningId} className="mt-4 rounded-lg border border-yellow-600/60 bg-yellow-900/30 p-3 text-sm text-yellow-100">
        {t("cancelOfferModalWarning")}
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
          className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          {t("cancelOfferModalConfirmButton")}
        </button>
      </div>
    </TradeDialog>
  );
}
