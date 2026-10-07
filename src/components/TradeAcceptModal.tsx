"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslations } from "next-intl";

import { ERROR_MESSAGES } from "@/lib/constants";
import type { TradeOfferDto } from "@/lib/trade";

type AcceptPhase =
  | { kind: "confirm" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; messageKey: string; refetchOnClose: boolean };

function mapAcceptError(status: number, serverMessage: string): {
  messageKey: string;
  refetchOnClose: boolean;
} {
  if (status === 429) return { messageKey: "errorRateLimited", refetchOnClose: false };
  switch (serverMessage) {
    case ERROR_MESSAGES.TRADE_OFFER_NOT_OPEN:
    case ERROR_MESSAGES.TRADE_OFFER_INVALID:
    case ERROR_MESSAGES.TRADE_OFFER_NOT_FOUND:
      // 成立済み・無効・削除済みは閲覧者への見え方が同じため一つの文言に集約し、
      // 閉じたら一覧を refetch する (§6.4)
      return { messageKey: "errorTradeAlreadyCompletedOrInvalid", refetchOnClose: true };
    case ERROR_MESSAGES.TRADE_BUSY:
      return { messageKey: "errorTradeBusy", refetchOnClose: false };
    case ERROR_MESSAGES.TRADE_CARD_NOT_OWNED:
      return { messageKey: "errorTradeCardNotOwned", refetchOnClose: true };
    case ERROR_MESSAGES.TRADE_SELF_ACCEPT:
      return { messageKey: "errorTradeSelfAccept", refetchOnClose: false };
    case ERROR_MESSAGES.TRADE_DISABLED:
      return { messageKey: "errorTradeDisabled", refetchOnClose: false };
    default:
      return { messageKey: "errorGeneric", refetchOnClose: false };
  }
}

function CardFace({
  name,
  rarity,
  imageUrl,
  label,
}: {
  name: string;
  rarity: string;
  imageUrl: string | null;
  label: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 text-center">
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={name} className="h-24 w-24 rounded-lg object-cover" />
      ) : (
        <div className="flex h-24 w-24 items-center justify-center rounded-lg bg-gray-700 text-xs text-gray-400">
          {name}
        </div>
      )}
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-sm font-semibold text-white">{name}</p>
      <p className="text-xs text-gray-400">{rarity}</p>
    </div>
  );
}

/**
 * 応諾確認モーダル (#726, §6.4)。
 * - focus trap + aria-modal + Esc で閉じる。初期フォーカスは非破壊的な
 *   「キャンセル」ボタン (Enter 連打での誤成立を防ぐ)。
 * - requestId は crypto.randomUUID() でモーダル表示時に生成し、リトライ間保持する。
 * - 送信中はボタンを disabled + ローディング表示にする。
 */
export default function TradeAcceptModal({
  offer,
  onClose,
  onSettled,
}: {
  offer: TradeOfferDto;
  onClose: () => void;
  /** 成功・成立済み系エラーの確定後に一覧を refetch するための通知 */
  onSettled: () => void;
}) {
  const t = useTranslations("trade");
  // リトライ間で同一 requestId を使い回すため、モーダル表示時に1回だけ生成する
  const [requestId] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<AcceptPhase>({ kind: "confirm" });
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Esc で閉じる (送信中・成功表示中は閉じさせない)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const current = phaseRef.current;
      if (current.kind === "submitting" || current.kind === "success") return;
      if (current.kind === "error") {
        if (current.refetchOnClose) onSettled();
        onClose();
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, onSettled]);

  // 初期フォーカスはキャンセルボタンへ
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // focus trap: モーダル内で Tab を循環させる
  const onTrapTab = useCallback((event: ReactKeyboardEvent) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const submit = useCallback(async () => {
    setPhase({ kind: "submitting" });
    try {
      const response = await fetch(`/api/trades/${offer.id}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (response.ok) {
        setPhase({ kind: "success" });
        return;
      }
      const mapped = mapAcceptError(response.status, body?.error ?? "");
      setPhase({ kind: "error", ...mapped });
    } catch {
      setPhase({ kind: "error", messageKey: "errorGeneric", refetchOnClose: false });
    }
  }, [offer.id, requestId]);

  const closeWithRefetch = useCallback(() => {
    onSettled();
    onClose();
  }, [onSettled, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("confirmModalTitle")}
        onKeyDown={onTrapTab}
        className="w-full max-w-md rounded-xl bg-gray-800 p-6"
      >
        {phase.kind === "success" ? (
          <div className="text-center">
            <p className="text-lg font-bold text-white">{t("confirmModalSuccess")}</p>
            <div className="mt-4 flex justify-center">
              {offer.wantedCard.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={offer.wantedCard.imageUrl}
                  alt={offer.wantedCard.name}
                  className="h-40 w-40 rounded-xl object-cover"
                />
              ) : null}
            </div>
            <p className="mt-2 text-sm font-semibold text-white">{offer.wantedCard.name}</p>
            <p className="text-xs text-gray-400">{offer.wantedCard.rarity}</p>
            <button
              ref={cancelRef}
              type="button"
              onClick={closeWithRefetch}
              className="mt-6 w-full rounded-lg bg-purple-600 px-4 py-2 font-semibold text-white hover:bg-purple-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
            >
              {t("modalCloseButton")}
            </button>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-bold text-white">{t("confirmModalTitle")}</h2>
            <div className="mt-4 flex items-start gap-2">
              <CardFace
                name={offer.wantedCard.name}
                rarity={offer.wantedCard.rarity}
                imageUrl={offer.wantedCard.imageUrl}
                label={`${t("confirmModalGiveLabel")}: ${offer.wantedCard.name}`}
              />
              <span
                role="img"
                aria-label={t("directionIconLabel")}
                className="mt-8 text-xl text-gray-300"
              >
                →
              </span>
              <CardFace
                name={offer.offeredCard.name}
                rarity={offer.offeredCard.rarity}
                imageUrl={offer.offeredCard.imageUrl}
                label={`${t("confirmModalReceiveLabel")}: ${offer.offeredCard.name}`}
              />
            </div>
            <p className="mt-2 text-sm text-gray-300">
              {t("confirmModalGiveLabel")}: {offer.wantedCard.name} / {t("confirmModalReceiveLabel")}:{" "}
              {offer.offeredCard.name}
            </p>
            <p className="mt-2 text-sm font-semibold text-yellow-300">{t("confirmModalWarning")}</p>
            {phase.kind === "error" && (
              <p role="alert" className="mt-3 rounded-lg bg-red-900/60 p-2 text-sm text-red-200">
                {t(phase.messageKey)}
              </p>
            )}
            <div className="mt-6 flex gap-3">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => {
                  if (phase.kind === "error" && phase.refetchOnClose) {
                    closeWithRefetch();
                    return;
                  }
                  onClose();
                }}
                disabled={phase.kind === "submitting"}
                className="flex-1 rounded-lg bg-gray-700 px-4 py-2 font-semibold text-white hover:bg-gray-600 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
              >
                {phase.kind === "error" && phase.refetchOnClose
                  ? t("modalCloseButton")
                  : t("confirmModalCancelButton")}
              </button>
              {phase.kind !== "error" && (
                <button
                  type="button"
                  onClick={submit}
                  disabled={phase.kind === "submitting"}
                  className="flex-1 rounded-lg bg-purple-600 px-4 py-2 font-semibold text-white hover:bg-purple-500 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
                >
                  {phase.kind === "submitting" ? t("confirmModalSubmitting") : t("confirmModalSubmitButton")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
