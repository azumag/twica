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

interface PaginationData {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

interface GachaHistoryTableProps {
  // Initial data from SSR / SSRからの初期データ
  initialHistory: GachaHistoryEntry[];
  initialPagination: PaginationData;
  // Whether to show streamer-specific features (filters, username column, view tabs)
  // 配信者固有の機能を表示するかどうか（フィルタ、ユーザー名列、表示切り替えタブ）
  isStreamer: boolean;
}

type ViewMode = "channel" | "personal";

/**
 * Gacha history table with pagination and optional filters
 * Streamers can switch between channel history and personal history via tabs
 * ページネーション・フィルタ付きガチャ履歴テーブル
 * 配信者はタブでチャンネル履歴と自分の履歴を切り替え可能
 */
export default function GachaHistoryTable({
  initialHistory,
  initialPagination,
  isStreamer,
}: GachaHistoryTableProps) {
  const t = useTranslations("gachaHistoryPage");
  const tRarity = useTranslations("rarity");
  const locale = useLocale();

  // Current view mode for streamers: "channel" (all users) or "personal" (own history)
  // 配信者の表示モード: "channel"（全ユーザー）or "personal"（自分の履歴）
  const [viewMode, setViewMode] = useState<ViewMode>("channel");
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
   * Fetch gacha history from API with current filters, page, and view mode
   * 現在のフィルタ、ページ、表示モードでAPIからガチャ履歴を取得
   */
  const fetchHistory = useCallback(
    async (
      page: number,
      currentFilters: typeof filters,
      mode: ViewMode = viewMode
    ) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("perPage", String(pagination.perPage));
        // When streamer views personal history, add view=personal param
        // 配信者が自分の履歴を見る場合、view=personal を追加
        if (isStreamer && mode === "personal") {
          params.set("view", "personal");
        }
        if (mode === "channel") {
          if (currentFilters.username)
            params.set("username", currentFilters.username);
          if (currentFilters.rarity)
            params.set("rarity", currentFilters.rarity);
          if (currentFilters.from) params.set("from", currentFilters.from);
          if (currentFilters.to) params.set("to", currentFilters.to);
        }

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
    [pagination.perPage, viewMode, isStreamer]
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

  const handleViewModeChange = (mode: ViewMode) => {
    if (mode === viewMode) return;
    setViewMode(mode);
    setFilters({});
    // Fetch page 1 with no filters for the new view mode
    // 新しい表示モードでフィルタなしのページ1を取得
    fetchHistory(1, {}, mode);
  };

  // Whether the current view shows channel-level data (username column, filters)
  // 現在のビューがチャンネルレベルのデータを表示しているか
  const showChannelFeatures = isStreamer && viewMode === "channel";

  return (
    <div>
      {/* View mode tabs for streamers / 配信者向け表示切り替えタブ */}
      {isStreamer && (
        <div className="mb-4 flex gap-2">
          {(["channel", "personal"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => handleViewModeChange(mode)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                viewMode === mode
                  ? "bg-purple-600 text-white"
                  : "border border-gray-600 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {t(`tabs.${mode}`)}
            </button>
          ))}
        </div>
      )}

      {/* Filters (channel view only) / フィルタ（チャンネルビューのみ） */}
      {showChannelFeatures && (
        <GachaHistoryFilters onFilterChange={handleFilterChange} />
      )}

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
                      {/* Show username in channel view / チャンネルビューではユーザー名を表示 */}
                      {showChannelFeatures && (
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
