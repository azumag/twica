"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { TradeOfferDto } from "@/lib/trade";
import {
  isListStaleCode,
  isOfferGoneCode,
  postTradeJson,
  tradeErrorMessageKey,
} from "@/lib/trade-client";
import TradeCardSummary from "./TradeCardSummary";
import TradeDialog from "./TradeDialog";

interface TradeAcceptModalProps {
  offer: TradeOfferDto;
  /**
   * Idempotency key for this offer, owned by the board so that it survives
   * closing/reopening the dialog until the server confirms the trade (§5).
   */
  requestId: string;
  /** writes blocked by maintenance mode */
  writeBlocked: boolean;
  /** Called once the server confirmed the trade (board drops the requestId). */
  onCompleted: () => void;
  /** `refetch`: the list is stale (trade completed or offer gone). */
  onClose: (result: { refetch: boolean }) => void;
}

/**
 * Accept confirmation dialog (§6.4).
 *
 * Accessibility (aria-modal, Escape, the focus trap and the background scroll
 * lock) lives in the shared <TradeDialog> shell, which both trade dialogs use
 * (#1754 item 5). This dialog only decides the initial focus target — the
 * non-destructive `Cancel` button, because the trade is immediate and
 * irreversible — and the copy shown per phase.
 */
export default function TradeAcceptModal({
  offer,
  requestId,
  writeBlocked,
  onCompleted,
  onClose,
}: TradeAcceptModalProps) {
  const t = useTranslations("trade");
  const tMaintenance = useTranslations("maintenance");
  const titleId = useId();
  const warningId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<"confirm" | "submitting" | "success">("confirm");
  const [errorText, setErrorText] = useState<string | null>(null);
  // offerGone: the offer is completed/invalid/unavailable, re-submitting
  // cannot succeed. listStale: the row shown on the board (offer, canAccept or
  // channel gate) is outdated, so the board refetches once the dialog closes.
  const [offerGone, setOfferGone] = useState(false);
  const [listStale, setListStale] = useState(false);

  const close = () => {
    if (phase === "submitting") return;
    onClose({ refetch: phase === "success" || listStale });
  };

  const submit = async () => {
    if (phase !== "confirm") return;
    if (writeBlocked) {
      setErrorText(tMaintenance("writeDisabled"));
      return;
    }
    setPhase("submitting");
    setErrorText(null);
    const result = await postTradeJson<{ success: true }>(
      `/api/trades/${offer.id}/accept`,
      { requestId },
    );
    if (result.ok) {
      onCompleted();
      setPhase("success");
      return;
    }
    setErrorText(
      result.maintenanceMessage
        ?? t(result.networkError ? "errorNetwork" : tradeErrorMessageKey(result.code)),
    );
    if (isOfferGoneCode(result.code)) setOfferGone(true);
    if (isListStaleCode(result.code)) setListStale(true);
    setPhase("confirm");
  };

  // The viewer receives the offerer's card and gives the requested one.
  const receive = offer.offeredCard;
  const give = offer.wantedCard;

  return (
    <TradeDialog
      labelId={titleId}
      descriptionId={phase === "success" ? undefined : warningId}
      onClose={close}
      initialFocusRef={phase === "success" ? closeButtonRef : cancelRef}
      focusKey={phase}
    >
      {phase === "success" ? (
        <>
          <h2 id={titleId} className="mb-4 text-center text-lg font-bold">
            {t("confirmModalSuccess")}
          </h2>
          <p className="mb-2 text-center text-sm text-gray-300">{t("confirmModalReceivedLabel")}</p>
          <div className="flex justify-center">
            <TradeCardSummary card={receive} size="lg" />
          </div>
          <p className="mt-4 text-center text-xs text-gray-400">{t("collectionDelayNotice")}</p>
          <div className="mt-5 flex justify-center">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={close}
              className="rounded-lg bg-purple-600 px-6 py-2 font-semibold text-white hover:bg-purple-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              {t("confirmModalCloseButton")}
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 id={titleId} className="mb-4 text-lg font-bold">
            {t("confirmModalTitle")}
          </h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <TradeCardSummary card={give} label={t("confirmModalGiveLabel")} />
            </div>
            <span
              role="img"
              aria-label={t("directionIconLabel")}
              className="self-center text-2xl text-purple-300 max-sm:rotate-90"
            >
              ⇄
            </span>
            <div className="min-w-0 flex-1">
              <TradeCardSummary card={receive} label={t("confirmModalReceiveLabel")} />
            </div>
          </div>
          <p id={warningId} className="mt-4 rounded-lg border border-yellow-600/60 bg-yellow-900/30 p-3 text-sm text-yellow-100">
            {t("confirmModalWarning")}
          </p>
          {errorText && (
            <p role="alert" className="mt-3 rounded-lg bg-red-900/40 p-3 text-sm text-red-200">
              {errorText}
            </p>
          )}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              ref={cancelRef}
              type="button"
              onClick={close}
              disabled={phase === "submitting"}
              className="rounded-lg bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("confirmModalCancelButton")}
            </button>
            <button
              type="button"
              onClick={submit}
              // Once the offer is known to be gone, re-submitting cannot succeed.
              disabled={phase === "submitting" || offerGone}
              aria-busy={phase === "submitting"}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === "submitting" && (
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                />
              )}
              {phase === "submitting" ? t("confirmModalSubmitting") : t("confirmModalSubmitButton")}
            </button>
          </div>
        </>
      )}
    </TradeDialog>
  );
}
