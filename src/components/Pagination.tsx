"use client";

import { useTranslations } from "next-intl";

interface PaginationProps {
  // Current page number (1-indexed)
  // 現在のページ番号（1始まり）
  currentPage: number;
  // Total number of pages
  // 総ページ数
  totalPages: number;
  // Callback when page changes
  // ページ変更時のコールバック
  onPageChange: (page: number) => void;
}

/**
 * Pagination component for navigating through pages
 * ページ間を移動するためのページネーションコンポーネント
 */
export default function Pagination({
  currentPage,
  totalPages,
  onPageChange,
}: PaginationProps) {
  const t = useTranslations("pagination");
  // Don't render if only one page or no pages
  // ページが1つ以下の場合はレンダリングしない
  if (totalPages <= 1) {
    return null;
  }

  /**
   * Handle previous page click
   * 前のページクリックを処理
   */
  const handlePrevious = () => {
    if (currentPage > 1) {
      onPageChange(currentPage - 1);
    }
  };

  /**
   * Handle next page click
   * 次のページクリックを処理
   */
  const handleNext = () => {
    if (currentPage < totalPages) {
      onPageChange(currentPage + 1);
    }
  };

  /**
   * Generate page numbers to display
   * Displays up to 5 page numbers centered around current page
   * 表示するページ番号を生成
   * 現在のページを中心に最大5つのページ番号を表示
   */
  const getPageNumbers = (): (number | "...")[] => {
    const pages: (number | "...")[] = [];
    const maxVisiblePages = 5;

    if (totalPages <= maxVisiblePages) {
      // Show all pages if total is less than max visible
      // 総ページ数が最大表示数以下の場合はすべて表示
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Calculate start and end of visible range
      // 表示範囲の開始と終了を計算
      let start = Math.max(1, currentPage - 2);
      let end = Math.min(totalPages, currentPage + 2);

      // Adjust if at the edges
      // 端にいる場合は調整
      if (currentPage <= 2) {
        end = maxVisiblePages;
      } else if (currentPage >= totalPages - 1) {
        start = totalPages - maxVisiblePages + 1;
      }

      // Add first page and ellipsis if needed
      // 必要に応じて最初のページと省略記号を追加
      if (start > 1) {
        pages.push(1);
        if (start > 2) {
          pages.push("...");
        }
      }

      // Add visible page numbers
      // 表示するページ番号を追加
      for (let i = start; i <= end; i++) {
        pages.push(i);
      }

      // Add last page and ellipsis if needed
      // 必要に応じて最後のページと省略記号を追加
      if (end < totalPages) {
        if (end < totalPages - 1) {
          pages.push("...");
        }
        pages.push(totalPages);
      }
    }

    return pages;
  };

  const pageNumbers = getPageNumbers();

  return (
    <div className="flex items-center justify-center gap-2">
      {/* Previous button */}
      {/* 前へボタン */}
      <button
        onClick={handlePrevious}
        disabled={currentPage === 1}
        className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t("previous")}
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 19l-7-7 7-7"
          />
        </svg>
      </button>

      {/* Page numbers */}
      {/* ページ番号 */}
      <div className="flex items-center gap-1">
        {pageNumbers.map((page, index) =>
          page === "..." ? (
            <span
              key={`ellipsis-${index}`}
              className="px-2 py-1 text-gray-500"
            >
              ...
            </span>
          ) : (
            <button
              key={page}
              onClick={() => onPageChange(page)}
              className={`min-w-[36px] rounded-lg px-3 py-2 text-sm ${
                currentPage === page
                  ? "bg-purple-600 text-white"
                  : "border border-gray-600 text-gray-300 hover:bg-gray-700"
              }`}
              aria-current={currentPage === page ? "page" : undefined}
            >
              {page}
            </button>
          )
        )}
      </div>

      {/* Next button */}
      {/* 次へボタン */}
      <button
        onClick={handleNext}
        disabled={currentPage === totalPages}
        className="rounded-lg border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t("next")}
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
      </button>

      {/* Page info */}
      {/* ページ情報 */}
      <span className="ml-2 text-sm text-gray-400">
        {t("pageInfo", { current: currentPage, total: totalPages })}
      </span>
    </div>
  );
}
