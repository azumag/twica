"use client";

import { useId, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { TradeableOwnedCopy, WantableCard } from "@/lib/trade";
import {
  postTradeJson,
  TRADE_AUCTION_DURATION_OPTIONS,
  tradeAuctionBoardPath,
  tradeErrorMessageKey,
} from "@/lib/trade-client";
import { clearTradeListCache } from "@/lib/use-trade-list";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import TradeCardChoiceList from "./TradeCardChoiceList";
import TradeCardSummary from "./TradeCardSummary";

/** Listing kind chosen first in the flow (#1791): a regular offer or an auction. */
export type TradeCreateKind = "offer" | "auction";
type AuctionDurationHours = (typeof TRADE_AUCTION_DURATION_OPTIONS)[number];

/** i18n key of each duration option (24 hours / 3 days / 7 days). */
const DURATION_LABEL_KEYS: Record<AuctionDurationHours, string> = {
  24: "createAuctionDuration24h",
  72: "createAuctionDuration3d",
  168: "createAuctionDuration7d",
};

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
   * Upper bound of the wanted quantity (TRADE_MAX_WANTED_QUANTITY, #1789).
   * Passed from the server page so this client component does not import the
   * server-only trade module; the API re-validates the range.
   */
  maxWantedQuantity: number;
  /**
   * Step 1 selection carried over the partner-selection navigation
   * (?offered=<cardId>). Ignored unless it is a listable card of this viewer.
   */
  initialOfferedCardId?: string | null;
  /**
   * Kind preselected by the entry point (?kind=auction from the board's
   * auction tab). The viewer can still switch it in the first step.
   */
  initialKind?: TradeCreateKind;
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
 *
 * Auctions (#1791, design §6): the flow starts with the listing kind. For an
 * auction, Step 1 is the same copy choice (the same lock rule applies:
 * `isListed` covers offers, auctions and bids), Step 2 is the deadline
 * (24 hours / 3 days / 7 days) instead of a wanted card, and the POST goes to
 * /api/trades/auctions. An auction has no counterpart channel, so the cross
 * partner picker belongs to the regular offer only; the kind switch keeps the
 * Step 1 choice because it is state of this mounted form.
 */
export default function TradeCreateForm({
  streamerId,
  cross,
  ownedCopies,
  wantableCards,
  wantableRevealsUnowned,
  boardHref,
  maxWantedQuantity,
  initialOfferedCardId = null,
  initialKind = "offer",
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
  const [kind, setKind] = useState<TradeCreateKind>(initialKind);
  // No default deadline: the viewer picks one explicitly, because it decides
  // how long the card (and every bid) stays locked.
  const [durationHours, setDurationHours] = useState<AuctionDurationHours | null>(null);
  const kindName = useId();
  const durationName = useId();
  const [wantedCardId, setWantedCardId] = useState<string | null>(null);
  const [wantedQuantity, setWantedQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  // requestId is bound to the exact selection (offered copy + wanted card +
  // wanted quantity). Retrying the same selection reuses it (idempotent replay
  // of a create the server may already have committed); changing any of them
  // creates a new key, because replaying an old key would return the OLD
  // offer instead of creating the newly selected one.
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

  const isAuction = kind === "auction";
  const canSubmit = isAuction
    ? Boolean(offeredUserCardId && durationHours !== null)
    : Boolean(offeredUserCardId && wanted);

  /**
   * Auction listing (POST /api/trades/auctions). The requestId is bound to
   * "auction:<copy>:<hours>" the same way as the offer selection, so a retry
   * of the same choice replays a committed create and a different choice
   * never replays the old auction.
   */
  const submitAuction = async () => {
    if (!offeredUserCardId || durationHours === null || submitting) return;
    if (writeBlocked) {
      setErrorText(tMaintenance("writeDisabled"));
      return;
    }
    setSubmitting(true);
    setErrorText(null);
    const requestId = requestIdFor(`auction:${offeredUserCardId}:${durationHours}`);
    const result = await postTradeJson("/api/trades/auctions", {
      offeredUserCardId,
      durationHours,
      requestId,
    });
    if (result.ok) {
      // The listed copy is now locked: every cached list (offer boards'
      // canAccept, auction lists) may be stale.
      clearTradeListCache();
      router.push(`${tradeAuctionBoardPath(streamerId, "in_channel")}&listed=1`);
      return;
    }
    setErrorText(
      result.maintenanceMessage
        ?? t(result.networkError ? "errorNetwork" : tradeErrorMessageKey(result.code)),
    );
    setSubmitting(false);
  };

  const submit = async () => {
    if (isAuction) {
      await submitAuction();
      return;
    }
    if (!offeredUserCardId || !wanted || submitting) return;
    if (writeBlocked) {
      setErrorText(tMaintenance("writeDisabled"));
      return;
    }
    setSubmitting(true);
    setErrorText(null);
    const requestId = requestIdFor(`${offeredUserCardId}:${wanted.cardId}:${wantedQuantity}`);
    const result = await postTradeJson<{ tradeOffer?: { wantedQuantity?: unknown } }>("/api/trades", {
      offeredUserCardId,
      wantedCardId: wanted.cardId,
      wantedQuantity,
      requestId,
    });
    if (result.ok) {
      // The board fetches on mount, so the new offer is shown first there.
      // Its client-side page cache (useTradeList) would otherwise serve a
      // fresh-looking list without the new offer, so drop it first. This also
      // applies to the mismatch branch below, where an offer WAS created.
      clearTradeListCache();
      // #1792 item 1: after a rollback to a server that predates
      // wantedQuantity, this (newer) bundle's xN request is accepted but the
      // old server ignores the field and lists a 1-copy offer, and its
      // response does not carry wantedQuantity at all (absent means exactly
      // one copy). Treating that as success would silently list a different,
      // cheaper trade than the one the viewer confirmed, so compare the
      // stored quantity with what was sent. The offer already exists (and a
      // retry of the same selection would just replay it), so do not
      // navigate away: tell the viewer to cancel it in My Trades. Only the
      // lister can lose out and the offer is cancellable, hence a message
      // instead of an automatic cancel call (no new write path).
      const storedQuantity = Number(result.data?.tradeOffer?.wantedQuantity ?? 1);
      if (storedQuantity !== wantedQuantity) {
        setErrorText(t("errorTradeQuantityMismatch", { requested: wantedQuantity, stored: storedQuantity }));
        setSubmitting(false);
        return;
      }
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

  const radioCardClass = (checked: boolean) =>
    `flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-purple-400 ${
      checked ? "border-purple-400 bg-purple-900/40" : "border-gray-700 bg-gray-800 hover:bg-gray-700"
    }`;

  return (
    <div className="flex flex-col gap-8">
      {/* Native radios: one choice out of two with built-in arrow-key
          navigation and labelling, no custom roving focus needed. */}
      <fieldset>
        <legend className="mb-3 text-lg font-semibold text-white">{t("createKindLabel")}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["offer", "auction"] as const).map((value) => (
            <label key={value} className={radioCardClass(kind === value)}>
              <input
                type="radio"
                name={kindName}
                value={value}
                checked={kind === value}
                disabled={submitting}
                onChange={() => {
                  setKind(value);
                  setErrorText(null);
                }}
                className="mt-1 accent-purple-500"
              />
              <span className="min-w-0">
                <span className="block font-semibold text-white">
                  {t(value === "auction" ? "createKindAuction" : "createKindOffer")}
                </span>
                <span className="mt-1 block text-gray-300">
                  {t(value === "auction" ? "createKindAuctionHelp" : "createKindOfferHelp")}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <section aria-labelledby="trade-step1">
        <h2 id="trade-step1" className="mb-3 text-lg font-semibold text-white">
          {t(isAuction ? "createAuctionStep1Title" : "createStep1Title")}
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
                          {t("quantityBadge", { count: group.ownedCount })}
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

      {isAuction ? (
        <fieldset>
          <legend className="mb-3 text-lg font-semibold text-white">{t("createAuctionStep2Title")}</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {TRADE_AUCTION_DURATION_OPTIONS.map((hours) => (
              <label key={hours} className={radioCardClass(durationHours === hours)}>
                <input
                  type="radio"
                  name={durationName}
                  value={hours}
                  checked={durationHours === hours}
                  disabled={submitting}
                  onChange={() => {
                    setDurationHours(hours);
                    setErrorText(null);
                  }}
                  className="mt-1 accent-purple-500"
                />
                <span className="font-semibold text-white">{t(DURATION_LABEL_KEYS[hours])}</span>
              </label>
            ))}
          </div>
          <p className="mt-3 text-sm text-gray-300">{t("createAuctionRulesNotice")}</p>
        </fieldset>
      ) : (
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
                <TradeCardChoiceList
                  choices={wantableCards.map((card) => {
                    const sameAsOffered = card.cardId === offeredCardId;
                    return {
                      cardId: card.cardId,
                      card,
                      disabled: sameAsOffered,
                      title: sameAsOffered ? t("createStep2SameCard") : undefined,
                      // Unowned cards are highlighted: they are what the
                      // collector is missing (§6.5).
                      highlighted: !card.isOwned,
                      badge: !card.isOwned ? (
                        <span className="ml-2 shrink-0 rounded bg-purple-700 px-1.5 py-0.5 text-xs text-white">
                          {t("createStep2UnownedBadge")}
                        </span>
                      ) : undefined,
                    };
                  })}
                  selectedCardId={wantedCardId}
                  onSelect={(cardId) => {
                    setWantedCardId(cardId);
                    setErrorText(null);
                  }}
                  disabled={submitting}
                />
              )}
              {wantableCards.length > 0 && (
                // A native <select> (1..max) instead of a free number input:
                // no parsing/clamping of typed text, and every value offered
                // is one the API accepts. Options include the unit in their
                // text so assistive technology need not interpret the ×N badge.
                <label className="mt-4 flex items-center gap-3 text-sm text-gray-200">
                  {t("createStep2QuantityLabel")}
                  <select
                    value={wantedQuantity}
                    disabled={submitting}
                    onChange={(event) => {
                      setWantedQuantity(Number(event.target.value));
                      setErrorText(null);
                    }}
                    className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
                  >
                    {Array.from({ length: maxWantedQuantity }, (_, index) => index + 1).map((value) => (
                      <option key={value} value={value}>
                        {t("createStep2QuantityOption", { count: value })}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </section>
      )}

      <section aria-labelledby="trade-step3" className="rounded-xl bg-gray-800 p-4">
        <h2 id="trade-step3" className="mb-3 text-lg font-semibold text-white">
          {t("createConfirmTitle")}
        </h2>
        <p className="text-sm text-gray-200">
          {isAuction
            ? offered && durationHours !== null
              ? t("createAuctionConfirmSummary", {
                  offeredCard: offered.name,
                  duration: t(DURATION_LABEL_KEYS[durationHours]),
                })
              : t("createAuctionConfirmPending")
            : offered && wanted
            ? wantedQuantity > 1
              ? t("createConfirmSummaryMultiple", {
                  offeredCard: offered.name,
                  wantedCard: wanted.name,
                  count: wantedQuantity,
                })
              : t("createConfirmSummary", { offeredCard: offered.name, wantedCard: wanted.name })
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
            disabled={!canSubmit || submitting}
            aria-busy={submitting}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting
              ? t("createSubmitting")
              : t(isAuction ? "createAuctionSubmitButton" : "createSubmitButton")}
          </button>
        </div>
      </section>
    </div>
  );
}
