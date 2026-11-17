import { redirect } from "next/navigation";

/**
 * /trade/mine is now a permanent alias of the /trade hub (#2078).
 *
 * Existing links (the collection header and the board's "manage my trades"
 * links) are intentionally left unchanged: a redirect keeps them working and
 * preserves bookmarks. The hub owns login gating and the SSR prefetch, so this
 * page does not read the session or query the database at all; anonymous
 * visitors are redirected to the hub, which then sends them to login with
 * returnTo=/trade.
 *
 * This static segment still takes precedence over /trade/[streamerId], so
 * "mine" is never interpreted as a streamer id.
 */
export default async function MyTradesPage() {
  redirect("/trade");
}
