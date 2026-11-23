import type { AbstractIntlMessages } from "next-intl";

/**
 * Client-side message namespaces, grouped by the layout that owns the
 * `NextIntlClientProvider` for that route subtree.
 *
 * Why this list exists:
 * `src/app/layout.tsx` used to pass `getMessages()` (all 55 namespaces, roughly
 * 134KB minified) to `NextIntlClientProvider` on every page, even though each
 * client component only reads a handful of namespaces. A client component can
 * only translate namespaces that are present in its nearest provider.
 *
 * Nested providers REPLACE, they do not merge: use-intl's `IntlProvider` does
 * `messages: messages === undefined ? prevContext?.messages : messages`, so once
 * a nested provider receives an explicit `messages` prop the parent catalog is
 * no longer visible below it. Every list below must therefore be self-sufficient
 * for its whole subtree (layout chrome included), and the root list only covers
 * the routes that have no provider of their own.
 *
 * These lists are not copied from memory. `tests/unit/i18n-client-namespaces.test.ts`
 * walks each segment's static import graph (relative imports, tsconfig paths,
 * dynamic `import()` and the exact `@/components/ChatAnnouncementSettings` alias),
 * finds reachable `"use client"` files and fails if any literal
 * `useTranslations("...")` namespace is missing. Add an entry here only after
 * that test proves it is reachable for the segment.
 */

/**
 * Namespaces needed by the root provider.
 *
 * Covered routes:
 * - `src/app/page.tsx` (home)
 * - `src/app/not-found.tsx` / `global-error.tsx`
 * - top-level public route segments that do not have a provider of their own:
 *   /about, /auth, /faq, /guide, /plans, /privacy, /releases, /usages
 *
 * /overlay is intentionally NOT covered here: it has its own empty provider
 * (see src/app/overlay/layout.tsx) because none of its client code translates.
 */
export const ROOT_CLIENT_NAMESPACES = [
  "auth",
  "common",
  "header",
  "languageSwitcher",
  "maintenance",
] as const;

/**
 * /dashboard/** subtree.
 *
 * Includes the layout chrome (Header links are server-rendered, but
 * DashboardNav, MaintenanceBanner, ChatDeliveryWarning and the settings panels
 * are client components) and every dashboard page, including nested settings
 * sub-namespaces such as `settingsPage.advanced` and `collection.album`. The
 * top-level `settingsPage` / `collection` entries pick those nested trees up.
 */
export const DASHBOARD_CLIENT_NAMESPACES = [
  "albumDisplaySettings",
  "announcementBanner",
  "auth",
  "cardManager",
  "cardView",
  "cardVisibilitySettings",
  "channelPointSettings",
  "channelPointsAccess",
  "chatAnnouncementSettings",
  "chatDeliveryWarning",
  "collection",
  "collectionProgress",
  "common",
  "dashboard",
  "duplicateTierSettings",
  "gachaHistoryPage",
  "gachaSoundSettings",
  "gachaStatsPage",
  "inquiriesPage",
  "languageSwitcher",
  "liveDirectorySettings",
  "maintenance",
  "multiDrawChatDelivery",
  "navigation",
  "overlaySettings",
  "packCompletionReward",
  "pagination",
  "rarity",
  "rarityProbability",
  "settingsPage",
  "supportPlan",
  "tradeSettings",
  "tradeWantedRestriction",
  "twitchSub",
  "voteCampaign",
] as const;

/**
 * /collection/** subtree: Header + DashboardNav chrome, collection progress /
 * pack completion widgets and the streamer collection screens.
 */
export const COLLECTION_CLIENT_NAMESPACES = [
  "auth",
  "collectionProgress",
  "common",
  "maintenance",
  "navigation",
  "packCompletionReward",
  "streamerCollection",
] as const;

/**
 * /trade/** subtree: both the anonymous public branch (Header is empty without a
 * session, PublicFooter is server-rendered) and the logged-in branch with
 * DashboardNav / MaintenanceBanner. Trade board, auction, offer and pagination
 * widgets are client components.
 */
export const TRADE_CLIENT_NAMESPACES = [
  "common",
  "maintenance",
  "navigation",
  "pagination",
  "rarity",
  "trade",
] as const;

/**
 * /live subtree: the public directory client components (LiveDirectory) and the
 * DashboardNav that is rendered for logged-in visitors.
 */
export const LIVE_CLIENT_NAMESPACES = ["livePage", "navigation"] as const;

/**
 * /tos subtree: TosAcceptButton reads `tosPage.accept` and the maintenance
 * warning text. Everything else on the page is a server component.
 */
export const TOS_CLIENT_NAMESPACES = ["maintenance", "tosPage"] as const;

/**
 * /overlay/** has no client component that calls `useTranslations`, so the
 * smallest correct payload is an empty object. This is deliberately not the root
 * list: the overlay must not start depending on chrome namespaces it never uses.
 * Note that the root provider still serialises ROOT_CLIENT_NAMESPACES for every
 * route (including /overlay); this nested empty provider does not reduce those
 * bytes, it only keeps the boundary honest and lets the static test detect a
 * future translated overlay component instead of silently borrowing a root key.
 */
export const OVERLAY_CLIENT_NAMESPACES = [] as const;

/**
 * Select only the requested top-level namespaces.
 *
 * Missing namespaces are skipped instead of being copied as `undefined`:
 * - `tests/unit/layout-nonce.test.tsx` mocks `getMessages()` as `{}` and must
 *   keep rendering the root layout.
 * - A feature branch can reach a layout before its catalog entry is merged; an
 *   absent key lets next-intl use its normal missing-message fallback instead of
 *   treating the namespace as configured.
 *
 * The returned object is a new top-level object; nested catalogs are shared by
 * reference (they are never mutated, and React serialises them immediately).
 */
export function pick(
  messages: AbstractIntlMessages,
  namespaces: readonly string[],
): AbstractIntlMessages {
  const picked: AbstractIntlMessages = {};

  for (const namespace of namespaces) {
    // Own-property check avoids names such as `constructor` being resolved
    // through Object.prototype and copied into the client payload.
    if (Object.prototype.hasOwnProperty.call(messages, namespace)) {
      picked[namespace] = messages[namespace];
    }
  }

  return picked;
}
