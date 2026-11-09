"use client";

import { useTranslations } from "next-intl";

interface TradePagerProps {
  page: number;
  hasMore: boolean;
  onPageChange: (page: number) => void;
}

/**
 * Previous/next pager for the trade lists.
 *
 * The trade APIs page with LIMIT pageSize+1 and only return `hasMore` (no
 * total count, which would cost an extra COUNT over the visibility-filtered
 * set), so the shared numbered <Pagination> cannot be used here.
 */
export default function TradePager({ page, hasMore, onPageChange }: TradePagerProps) {
  const t = useTranslations("trade");
  const tPagination = useTranslations("pagination");
  if (page <= 1 && !hasMore) return null;

  const buttonClass =
    "rounded-lg bg-gray-700 px-4 py-2 text-sm text-white transition-colors hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <nav aria-label={t("paginationLabel")} className="mt-6 flex items-center justify-center gap-3">
      <button
        type="button"
        className={buttonClass}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        {tPagination("previous")}
      </button>
      <span className="text-sm text-gray-300" aria-current="page">
        {t("pageNumber", { page })}
      </span>
      <button
        type="button"
        className={buttonClass}
        disabled={!hasMore}
        onClick={() => onPageChange(page + 1)}
      >
        {tPagination("next")}
      </button>
    </nav>
  );
}
