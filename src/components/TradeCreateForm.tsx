"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { TradeableOwnedCopy, WantableCard } from "@/lib/trade";
import { postTradeJson, tradeErrorMessageKey } from "@/lib/trade-client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import TradeCardSummary from "./TradeCardSummary";

/** Partner channel choice for cross-channel listings. */
export type TradeCreatePartner = {
  id: string;
  twitchDisplayName: string;
  twitchProfileImageUrl: string | null;
};

interface TradeCreateFormProps {
  streamerId: string;
  /** Present only for cross-channel listings. */
  cross: {
    partners: TradeCreatePartner[];
    selectedPartnerId: string | null;
  } | null;
  /** Viewer's copies of this channel's active cards (listTradeableOwnedCopies). */
  ownedCopies: TradeableOwnedCopy[];
  /**
   * Cards the viewer may ask for (listWantableCards): already filtered on the
   * server, so cards hidden from this viewer never reach the client.
   */
  wantableCards: WantableCard[];
  /** The wanted channel reveals unowned cards (else only owned are wantable). */
  wantableRevealsUnowned: boolean;
  /** Board to return to after listing. */
  boardHref: string;
  /**
   * Step 1 selection carried over the partner-selection navigation
   * (?offered=<cardId>). Ignored unless it is a listable card of this viewer.
   */
  initialOfferedCardId?: string | null;
}

/** One selectable card in Step 1 (copies grouped per card definition). */
type OwnedCardGroup = {
  cardId: string;
  name: string;
  rarity: string;
  imageUrl: string | null;
  ownedCount: number;
  listedCount: number;
  /** Copy to list: the oldest copy that is not already in an open offer. */
  availableUserCardId: string | null;
};

/**
 * Groups copies by card. The server returns one row per copy ordered by
 * rarity/name and obtained_at ASC, so the first unlisted copy of a group is
 * the oldest one — the same "oldest copy first" rule the accept RPC uses for
 * the acceptor's payment, which keeps the behaviour predictable for users.
 * Duplicates (×N, N ≥ 2) with a listable copy are sorted first as the
 * recommended cards to trade away (§6.5); otherwise server order is kept.
 */
function groupOwnedCopies(copies: TradeableOwnedCopy[]): OwnedCardGroup[] {
  const groups = new Map<string, OwnedCardGroup>();
  for (const copy of copies) {
    let group = groups.get(copy.cardId);
    if (!group) {
      group = {
        cardId: copy.cardId,
        name: copy.name,
        rarity: copy.rarity,
        imageUrl: copy.imageUrl,
        ownedCount: copy.ownedCount,
        listedCount: 0,
        availableUserCardId: null,
      };
      groups.set(copy.cardId, group);
    }
    if (copy.isListed) {
      group.listedCount += 1;
    } else if (!group.availableUserCardId) {
      group.availableUserCardId = copy.userCardId;
    }
  }
  const list = [...groups.values()];
  const recommended = (group: OwnedCardGroup) =>
    group.ownedCount > 1 && group.availableUserCardId !== null ? 0 : 1;
  // Array.prototype.sort is stable, so ties keep the server's rarity order.
  return list.sort((a, b) => recommended(a) - recommended(b));
}

/**
 * Listing flow (§6.5): Step 1 choose the copy to give, Step 2 choose the
 * wanted card (cross-channel: first choose the partner channel), then confirm.
 *
 * Partner selection navigates (?partner=) so that the server component loads
 * the partner's wantable cards with the visibility rule applied in SQL; no
 * new API endpoint is introduced for it.
 */
export default function TradeCreateForm({
  streamerId,
  cross,
  ownedCopies,
  wantableCards,
  wantableRevealsUnowned,
  boardHref,
  initialOfferedCardId = null,
}: TradeCreateFormProps) {
  const t = useTranslations("trade");
  const tMaintenance = useTranslations("maintenance");
  const router = useRouter();
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const writeBlocked = maintenanceMode !== "off";
  const groups = useMemo(() => groupOwnedCopies(ownedCopies), [ownedCopies]);
  const [offeredCardId, setOfferedCardId] = useState<string | null>(() =>
    groups.some((group) => group.cardId === initialOfferedCardId && group.availableUserCardId !== null)
      ? initialOfferedCardId
      : null,
  );
  const [wantedCardId, setWantedCardId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // requestId is bound to the exact selection (offered copy + wanted card).
  // Retrying the same selection reuses it (idempotent replay of a create the
  // server may already have committed); changing either card creates a new
  // key, because replaying an old key would return the OLD offer instead of
  // creating the newly selected one.
  const requestIdRef = useRef<{ selection: string; id: string } | null>(null);

  const offered = groups.find((group) => group.cardId === offeredCardId) ?? null;
  const wanted = wantableCards.find((card) => card.cardId === wantedCardId) ?? null;
  const offeredUserCardId = offered?.availableUserCardId ?? null;
  const partnerMissing = cross !== null && !cross.selectedPartnerId;

  const requestIdFor = (selection: string) => {
    if (requestIdRef.current?.selection !== selection) {
      requestIdRef.current = { selection, id: crypto.randomUUID() };
    }
    return requestIdRef.current.id;
  };

  const submit = async () => {
    if (!offeredUserCardId || !wanted || submitting) return;
    if (writeBlocked) {
      setErrorText(tMaintenance("writeDisabled"));
      return;
    }
    setSubmitting(true);
    setErrorText(null);
    const requestId = requestIdFor(`${offeredUserCardId}:${wanted.cardId}`);
    const result = await postTradeJson("/api/trades", {
      offeredUserCardId,
      wantedCardId: wanted.cardId,
      requestId,
    });
    if (result.ok) {
      // The board fetches on mount, so the new offer is shown first there.
      const separator = boardHref.includes("?") ? "&" : "?";
      router.push(`${boardHref}${separator}listed=1`);
      return;
    }
    setErrorText(
      result.maintenanceMessage
        ?? t(result.networkError ? "errorNetwork" : tradeErrorMessageKey(result.code)),
    );
    setSubmitting(false);
  };

  const tileBase =
    "flex w-full items-center rounded-xl border p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400";

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="trade-step1">
        <h2 id="trade-step1" className="mb-3 text-lg font-semibold text-white">
          {t("createStep1Title")}
        </h2>
        {groups.length === 0 ? (
          <p className="rounded-xl bg-gray-800 p-4 text-gray-400">{t("createStep1Empty")}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((group) => {
              const selectable = group.availableUserCardId !== null;
              const selected = group.cardId === offeredCardId;
              return (
                <li key={group.cardId}>
                  <button
                    type="button"
                    disabled={!selectable || submitting}
                    aria-pressed={selected}
                    onClick={() => {
                      setOfferedCardId(group.cardId);
                      // The same card cannot be wanted (TRADE_SAME_CARD).
                      if (wantedCardId === group.cardId) setWantedCardId(null);
                      setErrorText(null);
                    }}
                    className={`${tileBase} ${
                      selected
                        ? "border-purple-400 bg-purple-900/40"
                        : "border-gray-700 bg-gray-800 hover:bg-gray-700"
                    } disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-gray-800`}
                  >
                    <div className="min-w-0 flex-1">
                      <TradeCardSummary card={group} />
                    </div>
                    <div className="ml-2 flex shrink-0 flex-col items-end gap-1 text-xs">
                      {group.ownedCount > 1 && (
                        <span className="rounded bg-purple-600 px-1.5 py-0.5 font-semibold text-white">
                          {t("createStep1OwnedCount", { count: group.ownedCount })}
                        </span>
                      )}
                      {!selectable ? (
                        <span className="rounded bg-gray-600 px-1.5 py-0.5 text-gray-200">
                          {t("createStep1ListedBadge")}
                        </span>
                      ) : (
                        group.listedCount > 0 && (
                          <span className="text-gray-400">
                            {t("createStep1ListedCount", { count: group.listedCount })}
                          </span>
                        )
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="trade-step2">
        <h2 id="trade-step2" className="mb-3 text-lg font-semibold text-white">
          {t("createStep2Title")}
        </h2>
        {cross && (
          <div className="mb-4">
            <p className="mb-2 text-sm text-gray-300">{t("createStep2SelectStreamer")}</p>
            {cross.partners.length === 0 ? (
              <p className="rounded-xl bg-gray-800 p-4 text-sm text-gray-400">
                {t("createStep2NoPartners")}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {cross.partners.map((partner) => {
                  const selected = partner.id === cross.selectedPartnerId;
                  return (
                    <li key={partner.id}>
                      <Link
                        // Carry the Step 1 choice across this navigation
                        // (the form remounts with the partner's catalogue).
                        href={`/trade/${streamerId}/new?scope=cross&partner=${encodeURIComponent(partner.id)}${
                          offeredCardId ? `&offered=${encodeURIComponent(offeredCardId)}` : ""
                        }`}
                        aria-current={selected ? "true" : undefined}
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${
                          selected
                            ? "border-purple-400 bg-purple-900/40 text-white"
                            : "border-gray-600 bg-gray-800 text-gray-200 hover:bg-gray-700"
                        }`}
                      >
                        {partner.twitchProfileImageUrl && (
                          // unoptimized: Twitch CDN avatar (same as Header).
                          <Image
                            src={partner.twitchProfileImageUrl}
                            alt=""
                            width={20}
                            height={20}
                            className="h-5 w-5 rounded-full"
                            unoptimized
                          />
                        )}
                        {partner.twitchDisplayName}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {!partnerMissing && (
          <>
            {!wantableRevealsUnowned && (
              <p className="mb-3 rounded-xl border border-gray-600 bg-gray-800 p-3 text-sm text-gray-300">
                {t("createStep2UnrevealedNotice")}
              </p>
            )}
            {wantableCards.length === 0 ? (
              <p className="rounded-xl bg-gray-800 p-4 text-gray-400">{t("createStep2Empty")}</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {wantableCards.map((card) => {
                  const sameAsOffered = card.cardId === offeredCardId;
                  const selected = card.cardId === wantedCardId;
                  return (
                    <li key={card.cardId}>
                      <button
                        type="button"
                        disabled={sameAsOffered || submitting}
                        aria-pressed={selected}
                        title={sameAsOffered ? t("createStep2SameCard") : undefined}
                        onClick={() => {
                          setWantedCardId(card.cardId);
                          setErrorText(null);
                        }}
                        className={`${tileBase} ${
                          selected
                            ? "border-purple-400 bg-purple-900/40"
                            : card.isOwned
                              ? "border-gray-700 bg-gray-800 hover:bg-gray-700"
                              // Unowned cards are highlighted: they are what
                              // the collector is missing (§6.5).
                              : "border-purple-700/60 bg-gray-800 hover:bg-gray-700"
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        <div className="min-w-0 flex-1">
                          <TradeCardSummary card={card} />
                        </div>
                        {!card.isOwned && (
                          <span className="ml-2 shrink-0 rounded bg-purple-700 px-1.5 py-0.5 text-xs text-white">
                            {t("createStep2UnownedBadge")}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="trade-step3" className="rounded-xl bg-gray-800 p-4">
        <h2 id="trade-step3" className="mb-3 text-lg font-semibold text-white">
          {t("createConfirmTitle")}
        </h2>
        <p className="text-sm text-gray-200">
          {offered && wanted
            ? t("createConfirmSummary", { offeredCard: offered.name, wantedCard: wanted.name })
            : t("createConfirmPending")}
        </p>
        <p className="mt-2 text-xs text-gray-400">{t("createLimitNotice")}</p>
        {errorText && (
          <p role="alert" className="mt-3 rounded-lg bg-red-900/40 p-3 text-sm text-red-200">
            {errorText}
          </p>
        )}
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Link
            href={boardHref}
            className="rounded-lg bg-gray-700 px-4 py-2 text-center text-sm text-white hover:bg-gray-600"
          >
            {t("createBackToBoard")}
          </Link>
          <button
            type="button"
            onClick={submit}
            disabled={!offeredUserCardId || !wanted || submitting}
            aria-busy={submitting}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? t("createSubmitting") : t("createSubmitButton")}
          </button>
        </div>
      </section>
    </div>
  );
}
