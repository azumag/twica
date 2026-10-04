"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * only in the browser tab (never on the server, see `canUseSharedCache`), and
 * logout reloads the page, so it can never hand one viewer's offers (isOwnOffer
 * / canAccept are viewer-specific) to another account.
 */

export type TradeListPage = { offers: TradeOfferDto[]; hasMore: boolean };

export type TradeListView =
  | { status: "loading" }
  | { status: "error" }
  | ({ status: "ok" } & TradeListPage);

/**
 * How long a fetched page is reused without asking the server. Short on
 * purpose: the board is shared state that other viewers change, and after
 * this window the cached page is still shown instantly while it refreshes.
 */
export const TRADE_LIST_FRESH_MS = 30_000;

/** Upper bound of the shared (board) cache; oldest entries are evicted. */
const SHARED_CACHE_MAX_ENTRIES = 50;

type CachedPage = { page: TradeListPage; fetchedAt: number };

const sharedCache = new Map<string, CachedPage>();

function canUseSharedCache() {
  // Module state on the server would be shared by every request (and every
  // viewer) of the Worker isolate, so the shared cache is browser-only.
  return typeof window !== "undefined";
}

function rememberShared(url: string, entry: CachedPage) {
  if (!canUseSharedCache()) return;
  // Re-insert so that Map order is least-recently-written first.
  sharedCache.delete(url);
  sharedCache.set(url, entry);
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

/**
 * fetchedAt of a page rendered by the server: fresh, and its window starts
 * when the client first sees it (Date.now() must not run during render).
 */
const SERVER_RENDERED = -1;
/** fetchedAt of a page that is still shown but must be refreshed. */
const STALE = 0;

type Entry =
  | { status: "ok"; page: TradeListPage; fetchedAt: number }
  | { status: "error" };

function requestedPage(url: string): number {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const page = Number(new URLSearchParams(query).get("page") ?? "1");
  return Number.isFinite(page) ? page : 1;
}

function markAllStale(entries: Record<string, Entry>): Record<string, Entry> {
  const next: Record<string, Entry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    next[key] = entry.status === "ok" ? { ...entry, fetchedAt: STALE } : entry;
  }
  return next;
}

export function useTradeList(
  url: string,
  options: {
    /** Keep pages across remounts (module cache). Used by the board. */
    shared?: boolean;
    /** Server-rendered page for `initial.url`, treated as just fetched. */
    initial?: { url: string; page: TradeListPage } | null;
    /**
     * A page > 1 came back empty (its rows were accepted / cancelled
     * meanwhile): show `previousPage` instead of an empty state. Must be
     * stable (a state setter).
     */
    onEmptyPage: (previousPage: number) => void;
  },
): {
  view: TradeListView;
  /** Error banner "retry": show loading again and refetch this page. */
  retry: () => void;
  /**
   * After a mutation: forget every other page, keep this one on screen
   * (optionally edited, e.g. without a row that is known to be gone) and
   * refresh it in the background.
   */
  invalidate: (edit?: (page: TradeListPage) => TradeListPage) => void;
} {
  const { shared = false, initial = null, onEmptyPage } = options;

  // The single source of truth for what is shown AND how fresh it is, so a
  // page can never be considered fresh without data on screen. Seeded once
  // per mount; `initial` changing later (server re-render) is ignored and the
  // page follows this hook's freshness rules instead.
  const [entries, setEntries] = useState<Record<string, Entry>>(() => {
    const seeded: Record<string, Entry> = {};
    if (shared && canUseSharedCache()) {
      for (const [key, value] of sharedCache) {
        seeded[key] = { status: "ok", page: value.page, fetchedAt: value.fetchedAt };
      }
    }
    if (initial) {
      seeded[initial.url] = { status: "ok", page: initial.page, fetchedAt: SERVER_RENDERED };
    }
    return seeded;
  });
  // When the server-rendered page was first seen (effects only).
  const serverRenderedSeenAt = useRef<number | null>(null);
  // Bumped to force a refetch of the same url (retry / invalidate).
  const [revalidation, setRevalidation] = useState(0);

  const entry = entries[url];
  const entryFetchedAt = entry?.status === "ok" ? entry.fetchedAt : undefined;

  useEffect(() => {
    let stamp = entryFetchedAt;
    if (stamp === SERVER_RENDERED) {
      serverRenderedSeenAt.current ??= Date.now();
      stamp = serverRenderedSeenAt.current;
    }
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
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { offers?: TradeOfferDto[]; hasMore?: boolean };
        // A superseded query must not move the page or overwrite the result.
        if (controller.signal.aborted) return;
        const offers = Array.isArray(data.offers) ? data.offers : [];
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
        if (shared) rememberShared(url, { page: result, fetchedAt: now });
        setEntries((prev) => ({ ...prev, [url]: { status: "ok", page: result, fetchedAt: now } }));
      })
      .catch(() => {
        // An aborted request belongs to a superseded query.
        if (controller.signal.aborted) return;
        // A failed background refresh keeps the data already on screen; only
        // a page without data switches to the error state.
        setEntries((prev) =>
          prev[url]?.status === "ok" ? prev : { ...prev, [url]: { status: "error" } },
        );
      });
    return () => controller.abort();
  }, [url, entryFetchedAt, revalidation, shared, onEmptyPage]);

  const retry = useCallback(() => {
    sharedCache.delete(url);
    setEntries((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
    setRevalidation((value) => value + 1);
  }, [url]);

  const invalidate = useCallback(
    (edit?: (page: TradeListPage) => TradeListPage) => {
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

  const view: TradeListView = !entry
    ? { status: "loading" }
    : entry.status === "error"
      ? { status: "error" }
      : { status: "ok", offers: entry.page.offers, hasMore: entry.page.hasMore };
  return { view, retry, invalidate };
}
