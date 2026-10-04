import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { getTradeBoardStreamer, listWantableCards } from "@/lib/trade";
import { parseTradeScope, tradeBoardPath, tradeCreatePath, tradeLoginHref } from "@/lib/trade-client";
import TradeBoard from "@/components/TradeBoard";

const CREATE_CLASS =
  "rounded-lg bg-purple-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-purple-700";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Trade board /trade/[streamerId] (§6.2/§6.3). Readable without login.
 *
 * This server component only resolves the channel header/gates and the
 * filter options; the offers themselves are fetched by <TradeBoard> through
 * GET /api/trades so that the public listing stays behind the API's rate
 * limit. Every value handed to the client is already visibility-filtered:
 * filter options come from listWantableCards (SQL visibility rule), so names
 * of cards the viewer may not see never reach the browser.
 */
export default async function TradeBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ streamerId: string }>;
  searchParams: SearchParams;
}) {
  const [{ streamerId }, query] = await Promise.all([params, searchParams]);
  const scope = parseTradeScope(query.scope);
  const [session, streamer, t] = await Promise.all([
    getSession(),
    getTradeBoardStreamer(streamerId),
    getTranslations("trade"),
  ]);
  if (!streamer) notFound();

  const isLoggedIn = Boolean(session);
  const boardPath = tradeBoardPath(streamer.id, scope);
  const createPath = tradeCreatePath(streamer.id, scope);
  // Anonymous viewers are sent to login and come back to the listing flow.
  const createHref = isLoggedIn ? createPath : tradeLoginHref(createPath);
  const scopeEnabled = streamer.tradeEnabled && (scope === "in_channel" || streamer.crossChannelTradeEnabled);

  // Card filter is in-channel only (MVP decision); skip the query otherwise.
  const filterCards =
    scopeEnabled && scope === "in_channel"
      ? (await listWantableCards(session?.twitchUserId ?? null, streamer.id)).map((card) => ({
          cardId: card.cardId,
          name: card.name,
        }))
      : [];

  const tabClass = (active: boolean) =>
    `shrink-0 rounded-lg px-4 py-2 text-sm ${
      active ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
    }`;

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={`/collection/${streamer.id}`}
        className="text-sm text-purple-400 transition-colors hover:text-purple-300"
      >
        ← {t("backToCollection")}
      </Link>
      <div className="mt-3 mb-4 flex items-center gap-3">
        {streamer.twitchProfileImageUrl && (
          // unoptimized: Twitch CDN image (same as StreamerCollection).
          <Image
            src={streamer.twitchProfileImageUrl}
            alt=""
            width={48}
            height={48}
            className="h-12 w-12 rounded-full"
            unoptimized
          />
        )}
        <h1 className="text-2xl font-bold text-white">
          {t("boardTitle", { channelName: streamer.twitchDisplayName })}
        </h1>
      </div>

      {!streamer.tradeEnabled ? (
        <p className="rounded-xl bg-gray-800 p-6 text-center text-gray-300">{t("tradeDisabledNotice")}</p>
      ) : (
        <>
          <nav aria-label={t("tabsLabel")} className="mb-4 flex gap-2 overflow-x-auto">
            <Link
              href={tradeBoardPath(streamer.id, "in_channel")}
              aria-current={scope === "in_channel" ? "page" : undefined}
              className={tabClass(scope === "in_channel")}
            >
              {t("tabInChannel")}
            </Link>
            <Link
              href={tradeBoardPath(streamer.id, "cross_channel")}
              aria-current={scope === "cross_channel" ? "page" : undefined}
              className={tabClass(scope === "cross_channel")}
            >
              {t("tabCrossChannel")}
            </Link>
          </nav>

          {!scopeEnabled ? (
            <p className="rounded-xl bg-gray-800 p-6 text-center text-gray-300">{t("crossDisabledNotice")}</p>
          ) : (
            <>
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                {isLoggedIn ? (
                  <Link href={createHref} className={CREATE_CLASS}>
                    {t("createOfferButton")} +
                  </Link>
                ) : (
                  // Plain <a>: the login URL is an API route (no prefetch).
                  <a href={createHref} className={CREATE_CLASS}>
                    {t("loginToCreate")}
                  </a>
                )}
                {isLoggedIn && (
                  <Link href="/trade/mine" className="text-center text-sm text-purple-300 hover:text-purple-200">
                    {t("myTradesLink")}
                  </Link>
                )}
              </div>
              <TradeBoard
                // Remount per tab so page/filter state never leaks across scopes.
                key={scope}
                streamerId={streamer.id}
                scope={scope}
                isLoggedIn={isLoggedIn}
                revealsUnownedCards={streamer.revealsUnownedCards}
                filterCards={filterCards}
                loginHref={tradeLoginHref(boardPath)}
                createHref={createHref}
                justListed={query.listed === "1"}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
