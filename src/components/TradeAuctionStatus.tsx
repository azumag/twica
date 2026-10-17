"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { TradeAuctionDto } from "@/lib/trade-auction";
import { auctionPhaseLabelKey, tradeAuctionTimeLeft } from "@/lib/trade-client";

/** How often the countdown text is recomputed (minute resolution is shown). */
const TICK_MS = 30_000;

/**
 * Current time for the auction countdowns, re-read every TICK_MS so the
 * "time left" text does not freeze while the page stays open. Auction rows
 * are rendered on the client only (fetched after hydration), so there is no
 * server/client time mismatch to reconcile.
 */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * "Time left" text until `iso` (relative, design §6). Wrapped in <time> with
 * the machine-readable deadline so assistive technology and tests can read
 * the exact value; the label itself is approximate by design.
 */
export function TradeAuctionTimeLeft({ iso }: { iso: string }) {
  const t = useTranslations("trade");
  const now = useNowMs();
  const left = tradeAuctionTimeLeft(iso, now);
  let text: string;
  switch (left.kind) {
    case "daysHours":
      text = t("auctionTimeLeftDaysHours", { days: left.days, hours: left.hours });
      break;
    case "hoursMinutes":
      text = t("auctionTimeLeftHoursMinutes", { hours: left.hours, minutes: left.minutes });
      break;
    case "minutes":
      text = t("auctionTimeLeftMinutes", { minutes: left.minutes });
      break;
    case "soon":
      text = t("auctionTimeLeftSoon");
      break;
    default:
      // The client clock is past the deadline but the data predates it; the
      // server decides the real state on the next refresh / operation.
      text = t("auctionTimeLeftPassed");
  }
  return <time dateTime={iso}>{text}</time>;
}

const PHASE_CLASS: Record<TradeAuctionDto["phase"], string> = {
  bidding: "bg-emerald-700 text-emerald-50",
  selecting: "bg-yellow-700 text-yellow-50",
  completed: "bg-purple-700 text-white",
  expired: "bg-gray-600 text-gray-100",
  cancelled: "bg-gray-600 text-gray-100",
};

/**
 * Phase badge with text (never colour alone, §6.8). While bidding the badge
 * also carries the time left, since that is what a bidder acts on.
 */
export function TradeAuctionPhaseBadge({ auction }: { auction: Pick<TradeAuctionDto, "phase" | "endsAt"> }) {
  const t = useTranslations("trade");
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 rounded px-2 py-0.5 text-xs ${PHASE_CLASS[auction.phase]}`}>
      <span>{t(auctionPhaseLabelKey(auction.phase))}</span>
      {auction.phase === "bidding" && (
        <>
          <span aria-hidden="true">·</span>
          <TradeAuctionTimeLeft iso={auction.endsAt} />
        </>
      )}
    </span>
  );
}
