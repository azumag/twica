"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

/** The only ?listed values the hub accepts (#2080). */
export type TradeListedKind = "offer" | "auction";

/**
 * One-shot confirmation shown on /trade after the unified create form
 * redirects with `?listed=offer|auction` (#2080).
 *
 * Before #2080 a successful create navigated to the board, which rendered the
 * notice itself from `listedNotice` / `auctionListedNotice` (TradeBoard.tsx,
 * TradeAuctionBoard.tsx). The unified flow lands on the hub instead, so this
 * component reproduces that experience: it reuses the same two `trade`
 * messages and the boards' emerald notice styling, and, like the boards, it
 * removes `listed` from the address bar after showing it so a reload does not
 * repeat the confirmation.
 *
 * `history.replaceState` is deliberate (not `router.replace`): rewriting the
 * URL must neither navigate nor trigger a server render. The hub remounts
 * <MyTrades> on every router.refresh() with a per-request key; this notice is
 * not keyed, so a refresh whose URL no longer carries `listed` (the common
 * case after the replaceState) simply unmounts it. Letting a one-shot notice
 * disappear on refresh is acceptable — it is a confirmation, not state.
 */
export default function TradeListedNotice({ kind }: { kind: TradeListedKind }) {
  const t = useTranslations("trade");

  useEffect(() => {
    // [kind], not []: if this mounted instance ever receives another kind
    // (offer -> auction) without being remounted, the newly added `listed` has
    // to be stripped again. This mirrors the boards' [justListed] effect.
    const url = new URL(window.location.href);
    url.searchParams.delete("listed");
    window.history.replaceState(window.history.state, "", url);
  }, [kind]);

  return (
    <div
      role="status"
      className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100"
    >
      <p>{t(kind === "auction" ? "auctionListedNotice" : "listedNotice")}</p>
    </div>
  );
}
