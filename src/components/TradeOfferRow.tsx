"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { TradeOfferDto } from "@/lib/trade";
import { formatTradeDateTime } from "@/lib/trade-client";
import TradeCardSummary from "./TradeCardSummary";

interface TradeOfferRowProps {
  offer: TradeOfferDto;
  /** Cross-channel tab: show each card's channel next to it (§6.3). */
  showStreamers: boolean;
  isLoggedIn: boolean;
  /** Login URL that returns to this board (scope included). */
  loginHref: string;
  /** Writes are blocked by maintenance mode. */
  writeBlocked: boolean;
  onAccept: (offer: TradeOfferDto, trigger: HTMLButtonElement) => void;
}

const ACTIVE_BUTTON =
  "w-full rounded-lg bg-purple-600 px-4 py-2 text-center text-sm font-semibold text-white transition-colors hover:bg-purple-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto";
const INACTIVE_BUTTON =
  "w-full cursor-not-allowed rounded-lg bg-gray-700 px-4 py-2 text-center text-sm text-gray-300 sm:w-auto";

/**
 * One open offer on the board, rendered from the ACCEPTOR's point of view
 * (§6.3): the offerer's card is what the viewer receives ("もらう", first /
 * left), the requested card is what the viewer gives ("渡す", second / right).
 * An own offer instead uses the offerer's labels (give → want), because the
 * viewer is viewing their own listing. Card/channel order stays
 * offered → wanted for both perspectives; only the localized labels change.
 *
 * Narrow screens (375px) stack the two cards vertically (offered → wanted);
 * from `sm` they sit side by side. Direction is conveyed by text labels and
 * the ⇄ glyph, never by colour alone (§6.8).
 *
 * Action states (§11.3): own offer → badge (cancel lives in /trade/mine),
 * anonymous → "log in to accept" link, otherwise canAccept yes / not_owned /
 * all_listed. A logged-in row without canAccept (not computed by the API)
 * fails closed to the not-owned state rather than offering a doomed accept.
 */
export default function TradeOfferRow({
  offer,
  showStreamers,
  isLoggedIn,
  loginHref,
  writeBlocked,
  onAccept,
}: TradeOfferRowProps) {
  const t = useTranslations("trade");
  const locale = useLocale();

  let action: React.ReactNode;
  if (offer.isOwnOffer) {
    action = (
      <div className="flex flex-col items-stretch gap-1 sm:items-end">
        <span className="rounded-lg border border-purple-500 px-3 py-1 text-center text-sm text-purple-200">
          {t("ownOfferBadge")}
        </span>
        <Link href="/trade/mine" className="text-center text-xs text-purple-300 hover:text-purple-200">
          {t("ownOfferManageLink")}
        </Link>
      </div>
    );
  } else {
    let button: React.ReactNode;
    if (!isLoggedIn) {
      // Plain <a>: the target is an API route that starts OAuth; next/link
      // would try to prefetch it.
      button = (
        <a href={loginHref} className={ACTIVE_BUTTON}>
          {t("acceptButtonLoginRequired")}
        </a>
      );
    } else if (offer.canAccept === "yes") {
      button = (
        <button
          type="button"
          className={ACTIVE_BUTTON}
          disabled={writeBlocked}
          onClick={(event) => onAccept(offer, event.currentTarget)}
        >
          {t("acceptButton")}
        </button>
      );
    } else {
      button = (
        <button type="button" className={INACTIVE_BUTTON} disabled>
          {offer.canAccept === "all_listed" ? t("acceptButtonAllListed") : t("acceptButtonNotOwned")}
        </button>
      );
    }
    action = (
      <div className="flex flex-col items-stretch gap-1 sm:items-end">
        {button}
        {/* Always visible: the payment copy is chosen automatically and the
            trade cannot be undone, so this is announced before the dialog. */}
        <p className="text-xs text-gray-400">{t("autoSelectNotice")}</p>
      </div>
    );
  }

  return (
    <li className="rounded-xl bg-gray-800 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <TradeCardSummary
            card={offer.offeredCard}
            label={t(offer.isOwnOffer ? "myTradesGive" : "receiveLabel")}
            streamer={showStreamers ? offer.offeredStreamer : null}
          />
        </div>
        <span
          role="img"
          aria-label={t("directionIconLabel")}
          className="self-center text-2xl text-purple-300 max-sm:rotate-90"
        >
          ⇄
        </span>
        <div className="min-w-0 flex-1">
          <TradeCardSummary
            card={offer.wantedCard}
            label={t(offer.isOwnOffer ? "myTradesWant" : "giveLabel")}
            streamer={showStreamers ? offer.wantedStreamer : null}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-3 border-t border-gray-700 pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-gray-400">
          {t("offeredByLabel", { name: offer.offerer?.twitchDisplayName ?? t("unknownUser") })}
          {" · "}
          <time dateTime={offer.createdAt}>
            {formatTradeDateTime(offer.createdAt, locale)}
          </time>
        </p>
        {action}
      </div>
    </li>
  );
}
