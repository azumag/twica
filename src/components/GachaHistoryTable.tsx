"use client";

import { useState, useCallback } from "react";
import Image from "next/image";
import { useTranslations, useLocale } from "next-intl";
import { RARITY_COLORS } from "@/lib/constants";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import Pagination from "@/components/Pagination";
import GachaHistoryFilters from "@/components/GachaHistoryFilters";
import type { GachaHistory, Card, Rarity } from "@/types/database";

/**
 * Gacha history entry with joined card data
 * JOINされたカードデータ付きガチャ履歴エントリ
 */
type GachaHistoryEntry = GachaHistory & {
  cards: Pick<Card, "id" | "name" | "image_url" | "rarity">;
};

interface GachaHistoryTableProps {
  // Initial data from SSR / SSRからの初期データ
  initialHistory: GachaHistoryEntry[];
  initialPagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
  // Whether to show streamer-specific features (filters, username column)
  // 配信者固有の機能を表示するかどうか（フィルタ、ユーザー名列）
  isStreamer: boolean;
}

/**
 * Gacha history table with pagination and optional filters
 * Fetches data client-side when page or filters change
 * ページネーション・フィルタ付きガチャ履歴テーブル
 * ページやフィルタ変更時にクライアントサイドでデータを取得
 */
export default function GachaHistoryTable({
  initialHistory,
  initialPagination,
  isStreamer,
}: GachaHistoryTableProps) {
  const t = useTranslations("gachaHistoryPage");
  const tRarity = useTranslations("rarity");
  const locale = useLocale();

  const [history, setHistory] = useState(initialHistory);
  const [pagination, setPagination] = useState(initialPagination);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<{
    username?: string;
    rarity?: string;
    from?: string;
    to?: string;
  }>({});

  /**
   * Fetch gacha history from API with current filters and page
   * 現在のフィルタとページでAPIからガチャ履歴を取得
   */
  const fetchHistory = useCallback(
    async (page: number, currentFilters: typeof filters) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("perPage", String(pagination.perPage));
        if (currentFilters.username)
          params.set("username", currentFilters.username);
        if (currentFilters.rarity)
          params.set("rarity", currentFilters.rarity);
        if (currentFilters.from) params.set("from", currentFilters.from);
        if (currentFilters.to) params.set("to", currentFilters.to);

        const res = await fetch(`/api/gacha-history?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setHistory(data.history);
          setPagination(data.pagination);
        }
      } finally {
        setLoading(false);
      }
    },
    [pagination.perPage]
  );

  const handlePageChange = (page: number) => {
    fetchHistory(page, filters);
  };

  const handleFilterChange = (newFilters: typeof filters) => {
    setFilters(newFilters);
    // Reset to page 1 when filters change
    // フィルタ変更時はページ1にリセット
    fetchHistory(1, newFilters);
  };

  return (
    <div>
      {/* Filters (streamer only) / フィルタ（配信者のみ） */}
      {isStreamer && <GachaHistoryFilters onFilterChange={handleFilterChange} />}

      {/* Loading overlay / ローディングオーバーレイ */}
      <div className={`relative ${loading ? "opacity-50" : ""}`}>
        {/* Results count / 結果件数 */}
        <p className="mb-3 text-sm text-gray-400">
          {t("totalResults", { count: pagination.total })}
        </p>

        {/* Table / テーブル */}
        <div className="overflow-hidden rounded-xl bg-gray-800">
          <div className="divide-y divide-gray-700">
            {history.length === 0 ? (
              <div className="p-6 text-center text-gray-400">
                {t("emptyMessage")}
              </div>
            ) : (
              history.map((entry) => (
                <div key={entry.id} className="flex items-center gap-4 p-4">
                  {/* Card image / カード画像 */}
                  <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-gray-700">
                    {entry.cards.image_url ? (
                      <Image
                        src={getOptimizedImageUrl(
                          entry.cards.image_url,
                          "icon"
                        )}
                        alt={entry.cards.name}
                        width={48}
                        height={48}
                        className="h-full w-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xl">
                        🎴
                      </div>
                    )}
                  </div>

                  {/* Entry details / エントリ詳細 */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">
                      {entry.cards.name}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-gray-400">
                      {/* Show username for streamers / 配信者にはユーザー名を表示 */}
                      {isStreamer && (
                        <span>
                          {entry.user_twitch_username || t("unknownUser")}
                        </span>
                      )}
                      <span>
                        {new Date(entry.redeemed_at).toLocaleString(locale)}
                      </span>
                    </div>
                  </div>

                  {/* Rarity badge / レアリティバッジ */}
                  <div
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs text-white ${
                      RARITY_COLORS[entry.cards.rarity as Rarity]
                    }`}
                  >
                    {tRarity(entry.cards.rarity)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Pagination / ページネーション */}
        <div className="mt-4">
          <Pagination
            currentPage={pagination.page}
            totalPages={pagination.totalPages}
            onPageChange={handlePageChange}
          />
        </div>
      </div>
    </div>
  );
}
