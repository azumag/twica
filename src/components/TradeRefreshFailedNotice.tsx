"use client";

import { useTranslations } from "next-intl";

/**
 * Light notice shown ABOVE a trade list that is still on screen when its
 * background refresh failed (#1754 follow-up). The list is deliberately kept
 * (a stale list is more useful than an empty error state), but without this
 * notice the viewer could not tell that e.g. an accept button belongs to an
 * offer that may already be gone. `role="status"` keeps it polite for screen
 * readers; the hard "could not load" banner (role="alert") stays reserved for
 * a page that has no data at all.
 */
export default function TradeRefreshFailedNotice({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("trade");
  return (
    <div
      role="status"
      className="mb-3 flex flex-col items-center gap-2 rounded-lg border border-yellow-600/60 bg-yellow-900/30 p-3 text-sm text-yellow-100 sm:flex-row sm:justify-between"
    >
      <span>{t("refreshFailedNotice")}</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg bg-gray-700 px-3 py-1.5 text-white hover:bg-gray-600"
      >
        {t("retryButton")}
      </button>
    </div>
  );
}
