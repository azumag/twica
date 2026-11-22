import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { parseTradeScope, tradeCreateFlowPath, tradeLoginHref } from "@/lib/trade-client";
import { normalizeCanonicalUuid } from "@/lib/uuid-validation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Legacy listing route /trade/[streamerId]/new (#2080).
 *
 * It is now a pure view alias of the unified /trade/new flow. Converting the
 * URL (instead of keeping two implementations) preserves the old meaning for
 * bookmarks and for links on the board:
 *   - no parameters       → kind=offer&give=X&want=X (the old in-channel form)
 *   - ?scope=cross        → kind=offer&give=X        (the wanted channel was
 *                                                     picked in the old page)
 *   - ?scope=cross&partner=P → kind=offer&give=X&want=P
 *   - ?kind=auction       → kind=auction&give=X      (an auction has no want)
 *   - ?offered=           → carried through in every case so step 4 keeps the
 *                           viewer's card choice.
 *
 * No session or streamer lookup is needed to build the target, so an unknown
 * id is not an error here: an unparsable id goes to the bare /trade/new
 * (step 1), and an id that no longer exists is handled by the new page's own
 * gates. The session is only read afterwards to choose between the login
 * redirect and the target.
 * Anonymous visitors are sent to login with the CONVERTED URL, which is what
 * makes OAuth return to the new flow rather than this alias (one redirect
 * less after login).
 */
export default async function LegacyTradeCreatePage({
  params,
  searchParams,
}: {
  params: Promise<{ streamerId: string }>;
  searchParams: SearchParams;
}) {
  const [{ streamerId }, query] = await Promise.all([params, searchParams]);
  const give = normalizeCanonicalUuid(streamerId);
  if (!give) redirect("/trade/new");

  const kind = query.kind === "auction" ? "auction" : "offer";
  const partner = typeof query.partner === "string" ? query.partner : null;
  const offered = typeof query.offered === "string" ? query.offered : null;

  let target: string;
  if (kind === "auction") {
    target = tradeCreateFlowPath({ kind, give, offered });
  } else if (parseTradeScope(query.scope) === "cross_channel") {
    // No partner selected yet: step 3 of the new flow asks for the wanted
    // collection. With a partner, keep the old choice.
    target = tradeCreateFlowPath({ kind, give, want: partner, offered });
  } else {
    target = tradeCreateFlowPath({ kind, give, want: give, offered });
  }

  const session = await getSession();
  if (!session) redirect(tradeLoginHref(target));
  redirect(target);
}
