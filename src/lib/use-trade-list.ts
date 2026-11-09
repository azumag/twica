"use client";

import { useCallback, useEffect, useState } from "react";
import type { TradeOfferDto } from "@/lib/trade";

/**
 * Client-side cache for the paged trade lists (#727 performance follow-up).
 *
 * Every GET /api/trades(/mine) costs ~1 s on preview (DB round trips through
 * Hyperdrive), and the board / "my trades" UIs used to refetch on every tab or
 * page switch, showing "loading" each time. This hook implements the common
 * stale-while-revalidate pattern (as popularised by SWR / TanStack Query):
 *
 *   - a page that was fetched less than TRADE_LIST_FRESH_MS ago is shown
 *     without any request;
 *   - an older page is shown immediately and refreshed in the background;
 *   - "loading" is only shown for a page that has never been fetched;
 *   - after a mutation (accept / cancel / create) every cached page is dropped,
 *     because one change can move rows across pages, tabs and channels.
 *
 * Nothing is persisted: the data lives in React state, plus (board only) a
 * module-level Map so that switching the board's scope tab — which remounts
 * <TradeBoard> through a server navigation — can reuse pages. That Map exists
 * only in the browser tab (never on the server, see `canUseSharedCache`).
 * Offers carry viewer-specific fields (isOwnOffer / canAccept /
 * offeredUserCardId), and logging in as another account in a SECOND tab of the
 * same browser does not reload this tab, so entries are namespaced by a
 * `viewerKey` (a hash of the signed-in user, see tradeViewerKey) that the
 * server component hands down: a tab that navigates after an account switch
 * receives the new key and can never read the previous account's entries
 * (#1754 follow-up).
 *
 * A background refresh that fails keeps the stale page on screen and reports
 * `refreshFailed`, so the UI can tell the viewer the data may be out of date
 * and offer a retry (stale-while-revalidate with an error signal, as in
 * SWR's `error` next to `data`).
 */

/**
 * One page of a trade list. `offers` holds the page's rows: trade offers by
 * default, or auctions for the auction lists (#1791), which reuse this hook
 * through `rowsKey` and the type parameter instead of a second copy of the
 * cache. The field keeps its original name so the existing offer lists and
 * their tests stay unchanged.
 */
export type TradeListPage<T = TradeOfferDto> = { offers: T[]; hasMore: boolean };

export type TradeListView<T = TradeOfferDto> =
  | { status: "loading" }
  | {
      status: "error";
      /**
       * The server answered 503 TRADE_AUCTION_UNAVAILABLE: the auction schema
       * is not migrated yet (design §4.6 deploy window). The auction UI shows
       * a "not available yet" notice instead of a load error; the offer
       * endpoints never return this code.
       */
      unavailable?: boolean;
    }
  | ({
      status: "ok";
      /**
       * The page is shown from an earlier fetch/server render and the latest
       * background refresh failed, so it may be out of date.
       */
      refreshFailed: boolean;
    } & TradeListPage<T>);

/**
 * How long a fetched page is reused without asking the server. Short on
 * purpose: the board is shared state that other viewers change, and after
 * this window the cached page is still shown instantly while it refreshes.
 */
export const TRADE_LIST_FRESH_MS = 30_000;

/** Upper bound of the shared (board) cache; oldest entries are evicted. */
const SHARED_CACHE_MAX_ENTRIES = 50;

// The module cache stores pages of any row type: keys are URLs, and an offer
// URL (/api/trades...) can never equal an auction URL (/api/trades/auctions...),
// so a key is only ever read back by the list type that fetched it.
type CachedPage = { page: TradeListPage<unknown>; fetchedAt: number };

// Keys are `${viewerKey}${SHARED_KEY_SEPARATOR}${url}`: the viewer namespace
// comes first so one viewer's entries can be enumerated by prefix and never
// collide with another viewer's identical URL.
const sharedCache = new Map<string, CachedPage>();
// A newline cannot occur in a viewerKey, so the split point is unambiguous.
const SHARED_KEY_SEPARATOR = "\n";

function sharedKey(viewerKey: string, url: string) {
  return `${viewerKey}${SHARED_KEY_SEPARATOR}${url}`;
}

function canUseSharedCache() {
  // Module state on the server would be shared by every request (and every
  // viewer) of the Worker isolate, so the shared cache is browser-only.
  return typeof window !== "undefined";
}

function rememberShared(viewerKey: string, url: string, entry: CachedPage) {
  if (!canUseSharedCache()) return;
  // Re-insert so that Map order is least-recently-written first.
  const key = sharedKey(viewerKey, url);
  sharedCache.delete(key);
  sharedCache.set(key, entry);
  while (sharedCache.size > SHARED_CACHE_MAX_ENTRIES) {
    const oldest = sharedCache.keys().next().value;
    if (oldest === undefined) break;
    sharedCache.delete(oldest);
  }
}

/**
 * Drop every cached trade list page. Called after any trade mutation (also
 * from pages that do not render a list, e.g. the listing form) so that the
 * next board / "my trades" view loads current data.
 */
export function clearTradeListCache() {
  sharedCache.clear();
}

/** fetchedAt of a page that is still shown but must be refreshed. */
const STALE = 0;

type Entry<T> =
  | {
      status: "ok";
      page: TradeListPage<T>;
      fetchedAt: number;
      /** The last background refresh of this page failed (data is kept). */
      refreshFailed?: boolean;
    }
  | { status: "error"; unavailable?: boolean };

function requestedPage(url: string): number {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const page = Number(new URLSearchParams(query).get("page") ?? "1");
  return Number.isFinite(page) ? page : 1;
}

function markAllStale<T>(entries: Record<string, Entry<T>>): Record<string, Entry<T>> {
  const next: Record<string, Entry<T>> = {};
  for (const [key, entry] of Object.entries(entries)) {
    next[key] = entry.status === "ok" ? { ...entry, fetchedAt: STALE } : entry;
  }
  return next;
}

/** A non-2xx list response; carries the API error code when there is one. */
class TradeListFetchError extends Error {
  constructor(readonly code: string | undefined) {
    super(`trade list request failed${code ? `: ${code}` : ""}`);
  }
}

export function useTradeList<T = TradeOfferDto>(
  url: string,
  options: {
    /**
     * JSON field of the response that holds the rows: "offers" for
     * /api/trades(/mine) (default), "auctions" for /api/trades/auctions(/mine).
     */
    rowsKey?: "offers" | "auctions";
    /** Keep pages across remounts (module cache). Used by the board. */
    shared?: boolean;
    /**
     * Identity of the signed-in viewer (or a constant for anonymous). Scopes
     * the shared cache so another account's rows are never reused. Only
     * read when `shared` is true.
     */
    viewerKey?: string;
    /** Server-rendered page for `initial.url`, treated as just fetched. */
    initial?: { url: string; page: TradeListPage<T> } | null;
    /**
     * A page > 1 came back empty (its rows were accepted / cancelled
     * meanwhile): show `previousPage` instead of an empty state. Must be
     * stable (a state setter).
     */
    onEmptyPage: (previousPage: number) => void;
  },
): {
  view: TradeListView<T>;
  /** Error banner "retry": show loading again and refetch this page. */
  retry: () => void;
  /**
   * "Could not refresh" notice retry: keep the page on screen, clear the
   * notice and refetch it in the background.
   */
  refresh: () => void;
  /**
   * After a mutation: forget every other page, keep this one on screen
   * (optionally edited, e.g. without a row that is known to be gone) and
   * refresh it in the background.
   */
  invalidate: (edit?: (page: TradeListPage<T>) => TradeListPage<T>) => void;
} {
  const { shared = false, viewerKey = "", initial = null, onEmptyPage, rowsKey = "offers" } = options;

  // The single source of truth for what is shown AND how fresh it is, so a
  // page can never be considered fresh without data on screen. Seeded once
  // per mount; `initial` changing later (server re-render) is ignored and the
  // page follows this hook's freshness rules instead.
  const [entries, setEntries] = useState<Record<string, Entry<T>>>(() => {
    const seeded: Record<string, Entry<T>> = {};
    if (shared && canUseSharedCache()) {
      // Only this viewer's entries (see the file header): a key from another
      // account in the same browser must never be shown.
      const prefix = sharedKey(viewerKey, "");
      for (const [key, value] of sharedCache) {
        if (!key.startsWith(prefix)) continue;
        seeded[key.slice(prefix.length)] = {
          status: "ok",
          // Safe: a cached URL is only read back by the list type that
          // fetched it (see CachedPage).
          page: value.page as TradeListPage<T>,
          fetchedAt: value.fetchedAt,
        };
      }
    }
    if (initial) {
      // The server-rendered page is shown immediately but always revalidated
      // once on mount. App Router replays a cached RSC payload on browser
      // back/forward, so `initial` can be older than the user's last mutation
      // (e.g. an offer already cancelled would still show a cancel button).
      seeded[initial.url] = { status: "ok", page: initial.page, fetchedAt: STALE };
    }
    return seeded;
  });
  // Bumped to force a refetch of the same url (retry / invalidate).
  const [revalidation, setRevalidation] = useState(0);

  const entry = entries[url];
  const entryFetchedAt = entry?.status === "ok" ? entry.fetchedAt : undefined;

  useEffect(() => {
    const stamp = entryFetchedAt;
    if (stamp !== undefined && stamp !== STALE && Date.now() - stamp < TRADE_LIST_FRESH_MS) {
      return;
    }

    const controller = new AbortController();
    fetch(url, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          // Keep the API code: the auction lists tell the deploy window
          // (503 TRADE_AUCTION_UNAVAILABLE) apart from a real failure.
          const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
          throw new TradeListFetchError(typeof body?.code === "string" ? body.code : undefined);
        }
        const data = (await res.json()) as { hasMore?: boolean } & Record<string, unknown>;
        // A superseded query must not move the page or overwrite the result.
        if (controller.signal.aborted) return;
        const rows = data[rowsKey];
        const offers = (Array.isArray(rows) ? rows : []) as T[];
        const page = requestedPage(url);
        if (offers.length === 0 && page > 1) {
          // Rows vanished meanwhile, so every later page shifted: nothing
          // cached is trustworthy. Step back; that page is still shown from
          // the cache while it revalidates.
          clearTradeListCache();
          setEntries(markAllStale);
          onEmptyPage(page - 1);
          return;
        }
        const result = { offers, hasMore: data.hasMore === true };
        const now = Date.now();
        if (shared) rememberShared(viewerKey, url, { page: result, fetchedAt: now });
        setEntries((prev) => ({ ...prev, [url]: { status: "ok", page: result, fetchedAt: now } }));
      })
      .catch((error: unknown) => {
        // An aborted request belongs to a superseded query.
        if (controller.signal.aborted) return;
        const unavailable =
          error instanceof TradeListFetchError && error.code === "TRADE_AUCTION_UNAVAILABLE";
        // A failed background refresh keeps the data already on screen but
        // flags it, so the UI can say the data may be stale and offer a
        // retry (the entry keeps its fetchedAt, so this does not re-trigger
        // the effect: no automatic retry loop). A page without data switches
        // to the error state.
        setEntries((prev) => {
          const current = prev[url];
          return current?.status === "ok"
            ? { ...prev, [url]: { ...current, refreshFailed: true } }
            : { ...prev, [url]: { status: "error", unavailable } };
        });
      });
    return () => controller.abort();
  }, [url, entryFetchedAt, revalidation, shared, viewerKey, onEmptyPage, rowsKey]);

  const retry = useCallback(() => {
    sharedCache.delete(sharedKey(viewerKey, url));
    setEntries((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
    setRevalidation((value) => value + 1);
  }, [url, viewerKey]);

  const refresh = useCallback(() => {
    setEntries((prev) => {
      const current = prev[url];
      if (current?.status !== "ok") return prev;
      // STALE forces the fetch even when the page was fetched moments ago.
      return { ...prev, [url]: { status: "ok", page: current.page, fetchedAt: STALE } };
    });
    setRevalidation((value) => value + 1);
  }, [url]);

  const invalidate = useCallback(
    (edit?: (page: TradeListPage<T>) => TradeListPage<T>) => {
      clearTradeListCache();
      setEntries((prev) => {
        const current = prev[url];
        if (current?.status !== "ok") return {};
        return {
          [url]: {
            status: "ok",
            page: edit ? edit(current.page) : current.page,
            fetchedAt: STALE,
          },
        };
      });
      setRevalidation((value) => value + 1);
    },
    [url],
  );

  const view: TradeListView<T> = !entry
    ? { status: "loading" }
    : entry.status === "error"
      ? { status: "error", unavailable: entry.unavailable === true }
      : {
          status: "ok",
          offers: entry.page.offers,
          hasMore: entry.page.hasMore,
          refreshFailed: entry.refreshFailed === true,
        };
  return { view, retry, refresh, invalidate };
}
