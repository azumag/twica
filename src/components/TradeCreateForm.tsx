"use client";

import { useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { TradeableOwnedCopy, WantableCard } from "@/lib/trade";
import {
  postTradeJson,
  TRADE_AUCTION_DURATION_OPTIONS,
  tradeErrorMessageKey,
  type TradeCreateKind,
} from "@/lib/trade-client";
import { useTradeCardLabel } from "@/lib/trade-card-label";
import { clearTradeListCache } from "@/lib/use-trade-list";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";
import TradeCardChoiceList from "./TradeCardChoiceList";
import TradeCardSummary from "./TradeCardSummary";

type AuctionDurationHours = (typeof TRADE_AUCTION_DURATION_OPTIONS)[number];

/** The hub is both the form's back destination and where a successful create lands. */
const TRADE_HUB_PATH = "/trade";

/**
 * Post-create destination per kind (#2080).
 *
 * The old flow landed on the board with `?listed=1`, where the board rendered
 * the one-shot "listed" notice. The unified flow lands on the hub instead, so
 * it must carry the same confirmation as an allowlisted kind: the hub picks
 * the offer or auction copy from this value and its client component strips
 * the parameter after showing it (no navigation / server re-render). Kept as
 * one table so a new kind cannot silently lose the notice.
 */
const TRADE_HUB_LISTED_PATH: Record<TradeCreateKind, string> = {
  offer: `${TRADE_HUB_PATH}?listed=offer`,
  auction: `${TRADE_HUB_PATH}?listed=auction`,
};

/** i18n key of each duration option (24 hours / 3 days / 7 days). */
const DURATION_LABEL_KEYS: Record<AuctionDurationHours, string> = {
  24: "createAuctionDuration24h",
  72: "createAuctionDuration3d",
  168: "createAuctionDuration7d",
};

interface TradeCreateFormProps {
  /**
   * Listing kind decided by the page's step 1 (#2080). The form does not
   * switch it: an auction has no wanted card or counterpart channel, so the
   * page keeps the two flows apart before the form mounts.
   */
  kind: TradeCreateKind;
  /** Viewer's copies of this channel's active cards (listTradeableOwnedCopies). */
  ownedCopies: TradeableOwnedCopy[];
  /**
   * Cards the viewer may ask for (listWantableCards): already filtered on the
   * server, so cards hidden from this viewer never reach the client.
   */
  wantableCards: WantableCard[];
  /**
   * The wanted channel reveals unowned cards as rows (`show_unowned_cards`).
   * False means the catalogue below contains only cards the viewer owns, so the
   * "you can request your own cards only" notice is shown.
   *
   * 旧名 wantableRevealsUnowned は C3a で「行の可視性」から「名前の可視性」へ
   * 意味だけが差し替わり、案内文と食い違う状態になっていた。C4a で行と名前を
   * 別フラグに分け、それぞれの案内に対応させている。
   */
  wantableRevealsUnownedCards: boolean;
  /**
   * The wanted channel reveals the NAMES of unowned cards
   * (`revealsUnownedCardNames`). False means unowned entries arrive with
   * `name: ""` and are chosen by their display number (#N) instead.
   */
  wantableRevealsUnownedNames: boolean;
  /**
   * 出品カードの配信者が設定した「交換対象の制限」(ホワイトリスト)。出品カード id →
   * 選べる card id。キーが無いカードは制限なし、キーがあって空配列なら「指定できる
   * カードが無い」。サーバー(loadTradeCreateFormData)が公開済みの候補
   * (wantableCards)との交差を取って返すので、閲覧者に非公開のカード id は含まれない。
   * この絞り込みは UI の補助で、権威は出品 API(TRADE_WANTED_CARD_NOT_ALLOWED_FOR_OFFERED)。
   */
  allowedWantedByOfferedCardId?: Record<string, string[]>;
  /**
   * Upper bound of the wanted quantity (TRADE_MAX_WANTED_QUANTITY, #1789).
   * Passed from the server page so this client component does not import the
   * server-only trade module; the API re-validates the range.
   */
  maxWantedQuantity: number;
  /**
   * Step 1 selection carried over from the flow URL (?offered=<cardId>).
   * Ignored unless it is a listable card of this viewer.
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
 * Listing form (§6.5) for the last step of /trade/new (#2080).
 *
 * The page has already decided the listing kind, the collection to give and
 * (for an offer) the collection to ask from, so this form only handles the
 * cards: Step 1 chooses the copy to give, Step 2 chooses the wanted card and
 * quantity. The kind is a fixed prop rather than a switch, and the counterpart
 * channel is never selected here — the wanted catalogue passed by the page is
 * already the chosen channel's.
 *
 * Auctions (#1791, design §6): Step 1 is the same copy choice (the same lock
 * rule applies: `isListed` covers offers, auctions and bids), Step 2 is the
 * deadline (24 hours / 3 days / 7 days) instead of a wanted card, and the
 * POST goes to /api/trades/auctions.
 */
export default function TradeCreateForm({
  kind,
  ownedCopies,
  wantableCards,
  wantableRevealsUnownedCards,
  wantableRevealsUnownedNames,
  allowedWantedByOfferedCardId,
  maxWantedQuantity,
  initialOfferedCardId = null,
}: TradeCreateFormProps) {
  const t = useTranslations("trade");
  const tMaintenance = useTranslations("maintenance");
  const cardLabel = useTradeCardLabel();
  const router = useRouter();
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const writeBlocked = maintenanceMode !== "off";
  const groups = useMemo(() => groupOwnedCopies(ownedCopies), [ownedCopies]);
  const [offeredCardId, setOfferedCardId] = useState<string | null>(() =>
    groups.some((group) => group.cardId === initialOfferedCardId && group.availableUserCardId !== null)
      ? initialOfferedCardId
      : null,
  );
  // No default deadline: the viewer picks one explicitly, because it decides
  // how long the card (and every bid) stays locked.
  const [durationHours, setDurationHours] = useState<AuctionDurationHours | null>(null);
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
  // 選んだ出品カードの配信者にルールがあれば、選択肢を許可カードだけに絞る(サーバー順は維持)。
  // 出品カードを変えて許可外になった選択は、`wanted` が null になり送信できない。
  const allowedForOffered = offeredCardId
    ? allowedWantedByOfferedCardId?.[offeredCardId]
    : undefined;
  const isRestricted = allowedForOffered !== undefined;
  const choiceCards = useMemo(
    () =>
      allowedForOffered === undefined
        ? wantableCards
        : wantableCards.filter((card) => allowedForOffered.includes(card.cardId)),
    [wantableCards, allowedForOffered],
  );
  const wanted = choiceCards.find((card) => card.cardId === wantedCardId) ?? null;
  const offeredUserCardId = offered?.availableUserCardId ?? null;
  // 未所持カードが選択肢に含まれるか。名前が非公開でも未所持カードは
  // #N で選べる（C3a）ため、「全候補が所持済み」のときに #N の案内を出さない
  // よう、フラグだけでなく実データも見る。
  const hasUnownedChoice = choiceCards.some((card) => !card.isOwned);
  // #N 表記の理由を説明する案内（名前が非公開 かつ 未所持カードが候補にある）。
  const showsNumberOnlyNotice = !wantableRevealsUnownedNames && hasUnownedChoice;

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
      // #2080: land on the hub instead of the old board. The hub remounts
      // <MyTrades> on every request (key), so the new auction is visible there.
      // `?listed=auction` asks the hub to show the same one-shot confirmation
      // the auction board used to render after a create.
      router.push(TRADE_HUB_LISTED_PATH.auction);
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
      // The hub's <MyTrades> fetches on mount, so the new offer is shown there.
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
      // #2080: the hub is the destination for both kinds. `?listed=offer`
      // asks the hub to show the one-shot "listed" confirmation instead of the
      // old board's ?listed=1 flash; MyTrades is remounted by key either way.
      router.push(TRADE_HUB_LISTED_PATH.offer);
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
                        <span className="whitespace-nowrap rounded bg-purple-600 px-1.5 py-0.5 font-semibold text-white">
                          {t("quantityBadge", { count: group.ownedCount })}
                        </span>
                      )}
                      {!selectable ? (
                        <span className="whitespace-nowrap rounded bg-gray-600 px-1.5 py-0.5 text-gray-200">
                          {t("createStep1ListedBadge")}
                        </span>
                      ) : (
                        group.listedCount > 0 && (
                          <span className="whitespace-nowrap text-gray-400">
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
                <span className="shrink-0 whitespace-nowrap font-semibold text-white">
                  {t(DURATION_LABEL_KEYS[hours])}
                </span>
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
          {/* 未所持カードが候補に出ない（show_unowned_cards=false）場合の案内。
              これは行の可視性の話で、名前の公開可否（項目別）とは独立している（C3a）。 */}
          {!wantableRevealsUnownedCards && (
            <p className="mb-3 rounded-xl border border-gray-600 bg-gray-800 p-3 text-sm text-gray-300">
              {t("createStep2UnrevealedNotice")}
            </p>
          )}
          {/* 未所持カードは候補に出るが名前が非公開（#2070 フォローアップ）の場合、
              タイルが #N 表記になる理由を先に説明する。旧 createStep2NameOnlyNotice
              （「名前だけ公開」前提）は撤去した。 */}
          {showsNumberOnlyNotice && (
            <p className="mb-3 rounded-xl border border-gray-600 bg-gray-800 p-3 text-sm text-gray-300">
              {t("createStep2NumberOnlyNotice")}
            </p>
          )}
          {/* 出品カードに「交換対象の制限」があるとき、候補が絞られている理由を先に伝える。 */}
          {isRestricted && (
            <p className="mb-3 rounded-xl border border-gray-600 bg-gray-800 p-3 text-sm text-gray-300">
              {t("createStep2RestrictedNotice")}
            </p>
          )}
          {choiceCards.length === 0 ? (
            <p className="rounded-xl bg-gray-800 p-4 text-gray-400">
              {isRestricted ? t("createStep2RestrictedEmpty") : t("createStep2Empty")}
            </p>
          ) : (
            // 選択肢は listWantableCards が返した順（rarity_order → 表示番号 →
            // cardId）をそのまま使う。クライアント側で名前順に並べ替えると、
            // 名前非公開カードの名前の大小関係を漏らす side channel になる。
            <TradeCardChoiceList
              choices={choiceCards.map((card) => {
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
                    <span className="ml-2 shrink-0 whitespace-nowrap rounded bg-purple-700 px-1.5 py-0.5 text-xs text-white">
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
          {choiceCards.length > 0 && (
            // A native <select> (1..max) instead of a free number input:
            // no parsing/clamping of typed text, and every value offered
            // is one the API accepts. Options include the unit in their
            // text so assistive technology need not interpret the ×N badge.
            <label className="mt-4 flex min-w-0 flex-wrap items-center gap-2 text-sm text-gray-200">
              <span className="shrink-0 whitespace-nowrap">
                {t("createStep2QuantityLabel")}
              </span>
              <select
                value={wantedQuantity}
                disabled={submitting}
                onChange={(event) => {
                  setWantedQuantity(Number(event.target.value));
                  setErrorText(null);
                }}
                className="shrink-0 rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
              >
                {Array.from({ length: maxWantedQuantity }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {t("createStep2QuantityOption", { count: value })}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      )}

      <section aria-labelledby="trade-step3" className="rounded-xl bg-gray-800 p-4">
        <h2 id="trade-step3" className="mb-3 text-lg font-semibold text-white">
          {t("createConfirmTitle")}
        </h2>
        <p className="text-sm text-gray-200">
          {/* 確認文へ名前を埋め込む箇所は共通ヘルパーを通す。欲しいカードは名前が
              非公開だと name が "" で来るため、そのまま埋め込むと空欄になる。 */}
          {isAuction
            ? offered && durationHours !== null
              ? t("createAuctionConfirmSummary", {
                  offeredCard: cardLabel(offered),
                  duration: t(DURATION_LABEL_KEYS[durationHours]),
                })
              : t("createAuctionConfirmPending")
            : offered && wanted
            ? wantedQuantity > 1
              ? t("createConfirmSummaryMultiple", {
                  offeredCard: cardLabel(offered),
                  wantedCard: cardLabel(wanted),
                  count: wantedQuantity,
                })
              : t("createConfirmSummary", {
                  offeredCard: cardLabel(offered),
                  wantedCard: cardLabel(wanted),
                })
            : t("createConfirmPending")}
        </p>
        <p className="mt-2 text-xs text-gray-400">{t("createLimitNotice")}</p>
        {errorText && (
          <p role="alert" className="mt-3 rounded-lg bg-red-900/40 p-3 text-sm text-red-200">
            {errorText}
          </p>
        )}
        <div className="mt-4 flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Link
            href={TRADE_HUB_PATH}
            className="shrink-0 whitespace-nowrap rounded-lg bg-gray-700 px-4 py-2 text-center text-sm text-white hover:bg-gray-600"
          >
            {t("createFlowBackToHub")}
          </Link>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            aria-busy={submitting}
            className="shrink-0 whitespace-nowrap rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
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
