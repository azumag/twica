import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import TradeGuideLink from "@/components/TradeGuideLink";

import TradeCreateForm from "@/components/TradeCreateForm";
import { getSession } from "@/lib/session";
import {
  giveCollectionGate,
  isTradeAuctionSchemaAvailable,
  listViewerTradeCollections,
  loadTradeCreateFormData,
  wantCollectionGate,
  type TradeCreateCollection,
  type TradeCreateCollectionBlockReason,
  type TradeCreateFormData,
} from "@/lib/trade-create-flow";
import { listCrossTradePartnerStreamers, TRADE_MAX_WANTED_QUANTITY } from "@/lib/trade";
import {
  tradeCreateFlowPath,
  tradeLoginHref,
  type TradeCreateKind,
} from "@/lib/trade-client";
import { normalizeCanonicalUuid } from "@/lib/uuid-validation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const CHANGE_CLASS =
  "shrink-0 whitespace-nowrap text-sm text-purple-300 transition-colors hover:text-purple-200";
const CHOICE_CLASS =
  "flex min-w-0 flex-col rounded-xl border border-gray-700 bg-gray-800 p-4 text-left transition-colors hover:border-purple-400 hover:bg-gray-700";
const CANDIDATE_CLASS =
  "flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-gray-700 bg-gray-800 p-3 text-sm transition-colors hover:border-purple-400 hover:bg-gray-700";
const BADGE_CLASS =
  "shrink-0 whitespace-nowrap rounded-full border border-gray-600 bg-gray-900 px-2 py-0.5 text-xs text-gray-300";

/** A single query-string value. Repeated/array values are treated as absent. */
function stringParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** i18n key of a blocked-candidate reason. */
function blockReasonKey(reason: TradeCreateCollectionBlockReason): string {
  switch (reason) {
    case "trade_disabled":
      return "createFlowTradeDisabled";
    case "give_cross_disabled":
      return "createFlowGiveCrossDisabled";
    case "want_cross_disabled":
      return "createFlowWantCrossDisabled";
    case "want_no_tradeable_card":
      return "createFlowWantNoTradeableCard";
  }
}

/** Completed-step row: what is chosen plus a link that removes that step. */
function SummaryRow({
  label,
  value,
  badge,
  changeHref,
  changeLabel,
}: {
  label: string;
  value: string;
  /** Optional derived state (e.g. in-channel / cross-channel) next to the value. */
  badge?: React.ReactNode;
  changeHref: string;
  changeLabel: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span className="shrink-0 whitespace-nowrap text-gray-400">{label}</span>
      <span className="min-w-0 font-semibold text-white">{value}</span>
      {badge}
      <Link href={changeHref} className={CHANGE_CLASS}>
        {changeLabel}
      </Link>
    </div>
  );
}

/** Twitch avatar + display name, shared by the give/want candidate rows. */
function CollectionIdentity({ collection }: { collection: TradeCreateCollection }) {
  return (
    <>
      {collection.twitchProfileImageUrl && (
        // unoptimized: Twitch CDN avatar (same as the board and the header).
        <Image
          src={collection.twitchProfileImageUrl}
          alt=""
          width={24}
          height={24}
          className="h-6 w-6 shrink-0 rounded-full"
          unoptimized
        />
      )}
      <span className="min-w-0 font-semibold text-white">{collection.twitchDisplayName}</span>
    </>
  );
}

/**
 * Unified listing flow /trade/new (#2080). Login required.
 *
 * The viewer chooses the steps in order via links, so the flow works without
 * JavaScript and every step is a real URL:
 *   1. kind       ?kind=offer|auction
 *   2. give       &give=<streamerId>
 *   3. want       &want=<streamerId>   (offers only)
 *   4. cards      &offered=<cardId>    (rendered by <TradeCreateForm>)
 *
 * The in-channel / cross-channel scope is NOT a choice: it is derived here
 * from give === want. The create APIs keep their existing shape and the DB's
 * generated is_cross_channel column remains authoritative, so this page only
 * decides which catalogue the form shows; the form no longer selects the
 * counterpart channel (that decision belongs to step 3).
 *
 * URL parameters are untrusted: give/want must normalize to a canonical UUID
 * AND pass the same gate functions used to render the "selectable" state.
 * Without that, an arbitrary ?want= could make the server read another
 * channel's catalogue. An invalid value is simply treated as "not chosen",
 * which renders that step instead.
 *
 * Data loading:
 *   - one statement for all owned collections (listViewerTradeCollections),
 *   - listCrossTradePartnerStreamers as the cross-channel allowlist for the
 *     step-3 candidates,
 *   - the shared loadTradeCreateFormData for owned copies / wanted catalogue.
 * Every card passed to the client was already visibility-filtered in SQL.
 *
 * Static segments take precedence over /trade/[streamerId] in the App Router,
 * so /trade/new is this page and "new" is never interpreted as a streamer id
 * (same guarantee as /trade/mine).
 */
export default async function TradeNewPage({ searchParams }: { searchParams: SearchParams }) {
  const [query, session] = await Promise.all([searchParams, getSession()]);
  const kind: TradeCreateKind = query.kind === "auction" ? "auction" : "offer";
  const rawGive = stringParam(query.give);
  const rawWant = stringParam(query.want);
  const rawOffered = stringParam(query.offered);
  // `kind` defaults to offer, so the bare /trade/new has not chosen it yet and
  // must show step 1. A give value also proves the viewer got past step 1.
  const kindChosen =
    query.kind === "offer" || query.kind === "auction" || rawGive !== null;

  if (!session) {
    // Keep the whole query in returnTo (never just the path) so OAuth returns
    // to the same step. An unchosen kind stays a bare /trade/new: otherwise the
    // default would silently skip step 1 after login.
    redirect(
      tradeLoginHref(
        kindChosen
          ? tradeCreateFlowPath({ kind, give: rawGive, want: rawWant, offered: rawOffered })
          : "/trade/new",
      ),
    );
  }

  const viewerId = session.twitchUserId;
  // Only the step-1 choice and the auction flow render the auction entry
  // point, so a regular offer does not pay for the schema probe.
  const needAuctionProbe = !kindChosen || kind === "auction";
  const [collections, auctionAvailable, t, tGuide] = await Promise.all([
    listViewerTradeCollections(viewerId),
    needAuctionProbe ? isTradeAuctionSchemaAvailable() : Promise.resolve(true),
    getTranslations("trade"),
    getTranslations("tradeGuidePage"),
  ]);

  // --- Step 2: give collection ------------------------------------------------
  const giveId = rawGive ? normalizeCanonicalUuid(rawGive) : null;
  const giveCandidate = giveId
    ? (collections.find((collection) => collection.id === giveId) ?? null)
    : null;
  // Only a selectable candidate is accepted from the URL. The same gate renders
  // the list below, so a value can never be visually selectable yet rejected.
  const give =
    giveCandidate && giveCollectionGate(giveCandidate).selectable ? giveCandidate : null;

  // --- Step 3: want collection (offers only) ----------------------------------
  const wantId = rawWant ? normalizeCanonicalUuid(rawWant) : null;
  const wantCandidate =
    give && wantId ? (collections.find((collection) => collection.id === wantId) ?? null) : null;
  const sameCollection = give !== null && wantCandidate?.id === give.id;
  // The allowlist query is skipped for the in-channel case (want === give): it
  // would exclude the base channel anyway and the in-channel rule has no
  // partner condition. It is also skipped for auctions, which have no want.
  const needsCrossPartners =
    give !== null && kind === "offer" && !sameCollection;
  const crossPartners =
    give && needsCrossPartners
      ? await listCrossTradePartnerStreamers(viewerId, give.id)
      : [];
  const crossPartnerIds = new Set(crossPartners.map((partner) => partner.id));
  const wantGate =
    give && wantCandidate
      ? wantCollectionGate(give, wantCandidate, crossPartnerIds)
      : null;
  const want = kind === "offer" && wantGate?.selectable ? wantCandidate : null;

  // --- Step 4: the existing card form -----------------------------------------
  let formData: TradeCreateFormData | null = null;
  if (give && (kind === "offer" ? want !== null : auctionAvailable)) {
    formData = await loadTradeCreateFormData({
      viewerId,
      giveStreamerId: give.id,
      // An auction has no counterpart channel, so no wanted catalogue is read.
      wantStreamerId: kind === "offer" && want ? want.id : null,
    });
  }

  const kindLabel = t(kind === "auction" ? "createKindAuction" : "createKindOffer");

  return (
    <>
      {/* The unified flow's parent is the hub, and the form returns there on
          success as well (#2080). The hub remounts MyTrades by key, so the new
          listing is visible without an extra ?listed=1 parameter. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Link
          href="/trade"
          className="text-sm text-purple-400 transition-colors hover:text-purple-300"
        >
          ← {t("createFlowBackToHub")}
        </Link>
        <TradeGuideLink label={tGuide("entryLink")} />
      </div>
      <h1 className="mt-3 mb-4 text-2xl font-bold text-white">{t("createFlowTitle")}</h1>

      {kindChosen && (
        <div className="mb-6 flex flex-col gap-2">
          <SummaryRow
            label={t("createFlowStepKind")}
            value={kindLabel}
            changeHref="/trade/new"
            changeLabel={t("createFlowChange")}
          />
          {give && (
            <SummaryRow
              label={t("createFlowStepGive")}
              value={give.twitchDisplayName}
              changeHref={tradeCreateFlowPath({ kind })}
              changeLabel={t("createFlowChange")}
            />
          )}
          {kind === "offer" && give && want && (
            <SummaryRow
              label={t("createFlowStepWant")}
              value={want.twitchDisplayName}
              // The scope is never a choice in this flow; show the derived
              // result so the viewer can see which kind of trade step 4 will
              // create before submitting it.
              badge={
                <span className={BADGE_CLASS}>
                  {t(want.id === give.id ? "tabInChannel" : "tabCrossChannel")}
                </span>
              }
              changeHref={tradeCreateFlowPath({ kind: "offer", give: give.id })}
              changeLabel={t("createFlowChange")}
            />
          )}
        </div>
      )}

      {!kindChosen ? (
        <section aria-labelledby="trade-create-kind">
          <h2 id="trade-create-kind" className="mb-3 text-lg font-semibold text-white">
            {t("createFlowStepKindTitle")}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            <li>
              <Link href={tradeCreateFlowPath({ kind: "offer" })} className={CHOICE_CLASS}>
                <span className="block font-semibold text-white">{t("createKindOffer")}</span>
                <span className="mt-1 block text-sm text-gray-300">{t("createKindOfferHelp")}</span>
              </Link>
            </li>
            <li>
              {auctionAvailable ? (
                <Link href={tradeCreateFlowPath({ kind: "auction" })} className={CHOICE_CLASS}>
                  <span className="block font-semibold text-white">{t("createKindAuction")}</span>
                  <span className="mt-1 block text-sm text-gray-300">
                    {t("createKindAuctionHelp")}
                  </span>
                </Link>
              ) : (
                // Same "not available yet" copy as the auction board (#1791
                // deploy window), shown where the choice is made.
                <div
                  aria-disabled="true"
                  className={`${CHOICE_CLASS} pointer-events-none cursor-not-allowed opacity-60`}
                >
                  <span className="block font-semibold text-white">{t("createKindAuction")}</span>
                  <span className="mt-1 block text-sm text-gray-300">
                    {t("createKindAuctionHelp")}
                  </span>
                  <span className="mt-2 block text-xs text-gray-400">
                    {t("auctionUnavailableNotice")}
                  </span>
                </div>
              )}
            </li>
          </ul>
        </section>
      ) : kind === "auction" && !auctionAvailable ? (
        // Step 1 already chose the auction; the notice replaces step 2 so the
        // viewer never fills a form that cannot be submitted.
        <p role="status" className="rounded-xl bg-gray-800 p-6 text-center text-gray-300">
          {t("auctionUnavailableNotice")}
        </p>
      ) : !give ? (
        <section aria-labelledby="trade-create-give">
          <h2 id="trade-create-give" className="mb-3 text-lg font-semibold text-white">
            {t("createFlowStepGiveTitle")}
          </h2>
          {collections.length === 0 ? (
            <p className="rounded-xl bg-gray-800 p-6 text-center text-gray-300">
              {t("createFlowNoCollections")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {collections.map((collection) => {
                const gate = giveCollectionGate(collection);
                return (
                  <li key={collection.id}>
                    {gate.selectable ? (
                      <Link
                        href={tradeCreateFlowPath({ kind, give: collection.id })}
                        className={CANDIDATE_CLASS}
                      >
                        <CollectionIdentity collection={collection} />
                        <span aria-hidden="true" className="ml-auto shrink-0 text-gray-400">
                          →
                        </span>
                      </Link>
                    ) : (
                      <div
                        aria-disabled="true"
                        className={`${CANDIDATE_CLASS} pointer-events-none cursor-not-allowed opacity-60`}
                      >
                        <CollectionIdentity collection={collection} />
                        <span className="w-full text-xs text-gray-400">
                          {t(blockReasonKey(gate.reason))}
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : kind === "offer" && !want ? (
        <section aria-labelledby="trade-create-want">
          <h2 id="trade-create-want" className="mb-3 text-lg font-semibold text-white">
            {t("createFlowStepWantTitle")}
          </h2>
          {/* No tab choice: same collection = in-channel, different = cross. */}
          <p className="mb-3 text-sm text-gray-300">{t("createFlowWantScopeHint")}</p>
          <ul className="flex flex-col gap-2">
            {collections.map((collection) => {
              const gate = wantCollectionGate(give, collection, crossPartnerIds);
              const inChannel = collection.id === give.id;
              return (
                <li key={collection.id}>
                  {gate.selectable ? (
                    <Link
                      href={tradeCreateFlowPath({
                        kind: "offer",
                        give: give.id,
                        want: collection.id,
                      })}
                      className={CANDIDATE_CLASS}
                    >
                      <CollectionIdentity collection={collection} />
                      <span className={BADGE_CLASS}>
                        {t(inChannel ? "tabInChannel" : "tabCrossChannel")}
                      </span>
                      <span aria-hidden="true" className="ml-auto shrink-0 text-gray-400">
                        →
                      </span>
                    </Link>
                  ) : (
                    <div
                      aria-disabled="true"
                      className={`${CANDIDATE_CLASS} pointer-events-none cursor-not-allowed opacity-60`}
                    >
                      <CollectionIdentity collection={collection} />
                      <span className={BADGE_CLASS}>
                        {t(inChannel ? "tabInChannel" : "tabCrossChannel")}
                      </span>
                      <span className="w-full text-xs text-gray-400">
                        {t(blockReasonKey(gate.reason))}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : formData && give ? (
        <TradeCreateForm
          // Remount when the chosen collections change so a card selection from
          // another catalogue can never survive the navigation.
          key={`${give.id}:${want?.id ?? ""}`}
          // #2080: kind and counterpart are page decisions; the form only
          // handles the cards (and the deadline for an auction).
          kind={kind}
          ownedCopies={formData.ownedCopies}
          wantableCards={formData.wantableCards}
          wantableRevealsUnowned={formData.wantableRevealsUnowned}
          wantableRevealsUnownedImages={formData.wantableRevealsUnownedImages}
          maxWantedQuantity={TRADE_MAX_WANTED_QUANTITY}
          initialOfferedCardId={rawOffered}
        />
      ) : null}
    </>
  );
}
