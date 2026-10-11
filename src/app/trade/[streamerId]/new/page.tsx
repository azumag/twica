import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import {
  getTradeBoardStreamer,
  listCrossTradePartnerStreamers,
  listTradeableOwnedCopies,
  listWantableCards,
  type WantableCard,
} from "@/lib/trade";
import {
  parseTradeScope,
  tradeBoardPath,
  tradeCreatePath,
  tradeLoginHref,
} from "@/lib/trade-client";
import TradeCreateForm, { type TradeCreatePartner } from "@/components/TradeCreateForm";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Listing flow /trade/[streamerId]/new (§6.5). Login required.
 *
 * In-channel: give a copy of this channel's card, want another card of this
 * channel. Cross-channel (?scope=cross): give a copy of this channel's card,
 * want a card of a partner channel chosen via ?partner=<streamerId>. The
 * reverse direction (give the partner's card) is listed from the partner's
 * board, which keeps one "give from this channel" rule for Step 1.
 *
 * All data comes from server helpers (no new API): partner candidates are
 * channels the viewer collects from that allow cross trade, and wantable
 * cards are visibility-filtered in SQL, so hidden card names/images are never
 * serialized into the client component props.
 */
export default async function TradeCreatePage({
  params,
  searchParams,
}: {
  params: Promise<{ streamerId: string }>;
  searchParams: SearchParams;
}) {
  const [{ streamerId }, query] = await Promise.all([params, searchParams]);
  const scope = parseTradeScope(query.scope);
  const session = await getSession();
  if (!session) {
    // Same server-side returnTo pattern as /collection/[streamerId].
    redirect(tradeLoginHref(tradeCreatePath(streamerId, scope)));
  }

  const [streamer, t] = await Promise.all([
    getTradeBoardStreamer(streamerId),
    getTranslations("trade"),
  ]);
  if (!streamer) notFound();

  const boardHref = tradeBoardPath(streamer.id, scope);
  const header = (
    <>
      <Link href={boardHref} className="text-sm text-purple-400 transition-colors hover:text-purple-300">
        ← {t("createBackToBoard")}
      </Link>
      <h1 className="mt-3 mb-4 text-2xl font-bold text-white">
        {t("createPageTitle", { channelName: streamer.twitchDisplayName })}
      </h1>
    </>
  );

  const scopeEnabled =
    streamer.tradeEnabled && (scope === "in_channel" || streamer.crossChannelTradeEnabled);
  if (!scopeEnabled) {
    return (
      <div className="mx-auto max-w-4xl">
        {header}
        <p className="rounded-xl bg-gray-800 p-6 text-center text-gray-300">
          {streamer.tradeEnabled ? t("crossDisabledNotice") : t("tradeDisabledNotice")}
        </p>
      </div>
    );
  }

  const viewerId = session.twitchUserId;
  const loadWanted = async (): Promise<{
    wantableCards: WantableCard[];
    wantableRevealsUnowned: boolean;
    cross: { partners: TradeCreatePartner[]; selectedPartnerId: string | null } | null;
  }> => {
    if (scope === "in_channel") {
      return {
        wantableCards: await listWantableCards(viewerId, streamer.id),
        wantableRevealsUnowned: streamer.revealsUnownedCards,
        cross: null,
      };
    }
    // Only the fields the picker renders are serialized to the client.
    const partners = (await listCrossTradePartnerStreamers(viewerId, streamer.id)).map((item) => ({
      id: item.id,
      twitchDisplayName: item.twitchDisplayName,
      twitchProfileImageUrl: item.twitchProfileImageUrl,
    }));
    // Only a partner from the allowed candidate list is honoured; an arbitrary
    // ?partner= id cannot be used to read another channel's catalogue.
    const partner = partners.find((item) => item.id === query.partner) ?? null;
    const cross = { partners, selectedPartnerId: partner?.id ?? null };
    if (!partner) return { wantableCards: [], wantableRevealsUnowned: true, cross };
    const [cards, partnerInfo] = await Promise.all([
      listWantableCards(viewerId, partner.id),
      getTradeBoardStreamer(partner.id),
    ]);
    return {
      wantableCards: cards,
      wantableRevealsUnowned: partnerInfo?.revealsUnownedCards ?? false,
      cross,
    };
  };
  const [ownedCopies, { wantableCards, wantableRevealsUnowned, cross }] = await Promise.all([
    listTradeableOwnedCopies(viewerId, streamer.id),
    loadWanted(),
  ]);

  const tabClass = (active: boolean) =>
    `shrink-0 rounded-lg px-4 py-2 text-sm ${
      active ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
    }`;

  return (
    <div className="mx-auto max-w-4xl">
      {header}
      {streamer.crossChannelTradeEnabled && (
        <nav aria-label={t("createModeLabel")} className="mb-6 flex gap-2 overflow-x-auto">
          <Link
            href={tradeCreatePath(streamer.id, "in_channel")}
            aria-current={scope === "in_channel" ? "page" : undefined}
            className={tabClass(scope === "in_channel")}
          >
            {t("tabInChannel")}
          </Link>
          <Link
            href={tradeCreatePath(streamer.id, "cross_channel")}
            aria-current={scope === "cross_channel" ? "page" : undefined}
            className={tabClass(scope === "cross_channel")}
          >
            {t("tabCrossChannel")}
          </Link>
        </nav>
      )}
      <TradeCreateForm
        // Remount when the wanted catalogue changes so selections never refer
        // to cards that are no longer listed.
        key={`${scope}:${cross?.selectedPartnerId ?? ""}`}
        streamerId={streamer.id}
        cross={cross}
        ownedCopies={ownedCopies}
        wantableCards={wantableCards}
        wantableRevealsUnowned={wantableRevealsUnowned}
        boardHref={boardHref}
        initialOfferedCardId={typeof query.offered === "string" ? query.offered : null}
      />
    </div>
  );
}
