"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import { useTranslations, useLocale } from "next-intl";
import { RARITY_COLORS } from "@/lib/constants";
import { formatRarityLabel } from "@/lib/rarity";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import Pagination from "@/components/Pagination";
import GachaHistoryFilters from "@/components/GachaHistoryFilters";
import type { GachaHistory, Card, Rarity } from "@/types/database";
import type { GachaUserEntry } from "@/lib/dashboard-data";

/**
 * Gacha history entry with joined card data
 * JOINされたカードデータ付きガチャ履歴エントリ
 */
type GachaHistoryEntry = GachaHistory & {
  cards: Pick<Card, "id" | "name" | "image_url" | "rarity">;
  // Streamer info joined for personal history view
  // 自分の履歴表示用にJOINされた配信者情報
  streamers?: { twitch_display_name: string } | null;
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
  /** Available cards for card name filter / カード名フィルタ用カード一覧 */
  cards?: { id: string; name: string }[];
  /** Total active card count for user progress display / ユーザー進捗表示用のアクティブカード総数 */
  totalActiveCards?: number;
}

type ViewMode = "channel" | "personal" | "users";

/**
 * Gacha history table with pagination and optional filters
 * Streamers can switch between channel history, personal history, and user list via tabs
 * ページネーション・フィルタ付きガチャ履歴テーブル
 * 配信者はタブでチャネル履歴・自分の履歴・ユーザー一覧を切り替え可能
 */
export default function GachaHistoryTable({
  initialHistory,
  initialPagination,
  isStreamer,
  cards,
  totalActiveCards,
}: GachaHistoryTableProps) {
  const t = useTranslations("gachaHistoryPage");
  const tRarity = useTranslations("rarity");
  const locale = useLocale();

  // Current view mode for streamers
  // 配信者の表示モード
  const [viewMode, setViewMode] = useState<ViewMode>("channel");
  const [history, setHistory] = useState(initialHistory);
  const [pagination, setPagination] = useState(initialPagination);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<{
    username?: string;
    rarity?: string;
    cardId?: string;
    from?: string;
    to?: string;
  }>({});

  // Users tab state / ユーザータブの状態
  const [users, setUsers] = useState<GachaUserEntry[]>([]);
  const [usersPagination, setUsersPagination] = useState<PaginationData>({
    page: 1, perPage: 20, total: 0, totalPages: 0,
  });

  // User detail panel state / ユーザー詳細パネルの状態
  const [selectedUser, setSelectedUser] = useState<GachaUserEntry | null>(null);
  const [panelHistory, setPanelHistory] = useState<GachaHistoryEntry[]>([]);
  const [panelPagination, setPanelPagination] = useState<PaginationData>({
    page: 1, perPage: 20, total: 0, totalPages: 0,
  });
  const [panelLoading, setPanelLoading] = useState(false);
  const [showUniqueCardDetails, setShowUniqueCardDetails] = useState(false);
  // AbortController to cancel stale panel fetch on rapid user clicks
  // 素早いユーザークリック時に古いパネルfetchをキャンセルするAbortController
  const panelAbortRef = useRef<AbortController | null>(null);

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
          if (currentFilters.cardId)
            params.set("cardId", currentFilters.cardId);
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

  /**
   * Fetch users list for the users tab
   * ユーザータブ用のユーザー一覧を取得
   */
  const fetchUsers = useCallback(async (page: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("view", "users");
      params.set("page", String(page));
      params.set("perPage", "20");
      const res = await fetch(`/api/gacha-history?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
        setUsersPagination(data.pagination);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Fetch user's individual gacha history for the detail panel
   * ユーザー詳細パネル用の個別ガチャ履歴を取得
   */
  const fetchUserHistory = useCallback(async (userId: string, page: number) => {
    // Cancel any in-flight panel request to prevent stale data from overwriting
    // 飛行中のパネルリクエストをキャンセルして古いデータの上書きを防止
    panelAbortRef.current?.abort();
    const controller = new AbortController();
    panelAbortRef.current = controller;

    setPanelLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("perPage", "20");
      params.set("userId", userId);
      const res = await fetch(`/api/gacha-history?${params.toString()}`, {
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        setPanelHistory(data.history);
        setPanelPagination(data.pagination);
      }
    } catch (e) {
      // Ignore abort errors from cancelled requests
      if (e instanceof DOMException && e.name === "AbortError") return;
      throw e;
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const handlePageChange = (page: number) => {
    if (viewMode === "users") {
      fetchUsers(page);
    } else {
      fetchHistory(page, filters);
    }
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
    if (mode === "users") {
      fetchUsers(1);
    } else {
      // Fetch page 1 with no filters for the new view mode
      // 新しい表示モードでフィルタなしのページ1を取得
      fetchHistory(1, {}, mode);
    }
  };

  const handleUserClick = (user: GachaUserEntry) => {
    setSelectedUser(user);
    setShowUniqueCardDetails(false);
    // Clear previous panel data to prevent stale content display
    // 前回のパネルデータをクリアして古いデータの表示を防止
    setPanelHistory([]);
    setPanelPagination({ page: 1, perPage: 20, total: 0, totalPages: 0 });
    fetchUserHistory(user.userTwitchId, 1);
  };

  const handlePanelPageChange = (page: number) => {
    if (selectedUser) {
      fetchUserHistory(selectedUser.userTwitchId, page);
    }
  };

  const handleClosePanel = useCallback(() => {
    setSelectedUser(null);
    setPanelHistory([]);
    setShowUniqueCardDetails(false);
  }, []);

  // Close modal on Escape key / Escapeキーでモーダルを閉じる
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedUser) {
        handleClosePanel();
      }
    },
    [selectedUser, handleClosePanel]
  );

  useEffect(() => {
    if (selectedUser) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [selectedUser, handleKeyDown]);

  // Whether the current view shows channel-level data (username column, filters)
  // 現在のビューがチャネルレベルのデータを表示しているか
  const showChannelFeatures = isStreamer && viewMode === "channel";
  const currentPagination = viewMode === "users" ? usersPagination : pagination;
  const selectedUserUniqueCardIdSet = new Set(selectedUser?.uniqueCardIds || []);
  const ownedUniqueCards = (cards || []).filter((card) =>
    selectedUserUniqueCardIdSet.has(card.id)
  );
  const missingUniqueCards = (cards || []).filter(
    (card) => !selectedUserUniqueCardIdSet.has(card.id)
  );

  return (
    <div>
      {/* View mode tabs for streamers / 配信者向け表示切り替えタブ */}
      {isStreamer && (
        <div className="mb-4 flex gap-2">
          {(["channel", "personal", "users"] as const).map((mode) => (
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

      {/* Filters (channel view only) / フィルタ（チャネルビューのみ） */}
      {showChannelFeatures && (
        <GachaHistoryFilters onFilterChange={handleFilterChange} cards={cards} />
      )}

      {/* Loading overlay / ローディングオーバーレイ */}
      <div className={`relative ${loading ? "opacity-50" : ""}`}>
        {/* Results count / 結果件数 */}
        <p className="mb-3 text-sm text-gray-400">
          {t("totalResults", { count: currentPagination.total })}
        </p>

        {/* Users view / ユーザービュー */}
        {viewMode === "users" ? (
          <div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {users.length === 0 ? (
                <div className="col-span-full rounded-xl bg-gray-800 p-6 text-center text-gray-400">
                  {t("emptyMessage")}
                </div>
              ) : (
                users.map((user) => (
                  <button
                    key={user.userTwitchId}
                    onClick={() => handleUserClick(user)}
                    className="rounded-xl bg-gray-800 p-4 text-left hover:bg-gray-700 transition-colors"
                  >
                    <p className="truncate text-sm font-medium text-white">
                      {user.username || t("unknownUser")}
                    </p>
                    <div className="mt-1 flex items-center gap-3 text-xs text-gray-400">
                      <span>{t("users.drawCount", { count: user.drawCount })}</span>
                      {totalActiveCards !== undefined && totalActiveCards > 0 && (
                        <span>{t("users.collectionProgress", { owned: user.uniqueCards, total: totalActiveCards })}</span>
                      )}
                    </div>
                    {/* Collection progress bar / コレクション進捗バー */}
                    {totalActiveCards !== undefined && totalActiveCards > 0 && (
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-700">
                        <div
                          className="h-full rounded-full bg-emerald-500/90 transition-all"
                          style={{ width: `${Math.min(100, Math.round((user.uniqueCards / totalActiveCards) * 100))}%` }}
                        />
                      </div>
                    )}
                    <p className="mt-1 text-xs text-gray-500">
                      {t("users.lastDraw", { date: new Date(user.lastDrawAt).toLocaleDateString(locale) })}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          /* History table / 履歴テーブル */
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
                        {/* Show username in channel view / チャネルビューではユーザー名を表示 */}
                        {showChannelFeatures && (
                          <span>
                            {entry.user_twitch_username || t("unknownUser")}
                          </span>
                        )}
                        {/* Show channel name in personal view / 自分の履歴ではチャネル名を表示 */}
                        {!showChannelFeatures && entry.streamers && (
                          <span>{entry.streamers.twitch_display_name}</span>
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
                      {formatRarityLabel(entry.cards.rarity, tRarity)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Pagination / ページネーション */}
        <div className="mt-4">
          <Pagination
            currentPage={currentPagination.page}
            totalPages={currentPagination.totalPages}
            onPageChange={handlePageChange}
          />
        </div>
      </div>

      {/* User detail panel (modal overlay) / ユーザー詳細パネル（モーダルオーバーレイ） */}
      {selectedUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={(e) => { if (e.target === e.currentTarget) handleClosePanel(); }}
        >
          <div className="relative mx-4 max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-gray-800 p-6">
            {/* Panel header / パネルヘッダー */}
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">
                {t("users.userHistory", { username: selectedUser.username })}
              </h3>
              <button
                onClick={handleClosePanel}
                className="rounded-lg border border-gray-600 px-3 py-1 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
              >
                {t("users.close")}
              </button>
            </div>

            {/* Panel content / パネルコンテンツ */}
            <div className={panelLoading ? "opacity-50" : ""}>
              <p className="mb-3 text-sm text-gray-400">
                {t("totalResults", { count: panelPagination.total })}
              </p>
              {(cards?.length || 0) > 0 && (
                <div className="mb-3">
                  <button
                    onClick={() => setShowUniqueCardDetails((prev) => !prev)}
                    className="rounded-lg border border-gray-600 px-3 py-1 text-xs font-medium text-gray-200 hover:bg-gray-700 transition-colors"
                  >
                    {showUniqueCardDetails
                      ? t("users.hideUniqueCards")
                      : t("users.showUniqueCards")}
                  </button>
                </div>
              )}

              {showUniqueCardDetails && (cards?.length || 0) > 0 && (
                <div className="mb-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                    <p className="mb-2 text-xs font-semibold text-rose-300">
                      {t("users.missingUniqueCards", { count: missingUniqueCards.length })}
                    </p>
                    {missingUniqueCards.length === 0 ? (
                      <p className="text-xs text-gray-500">{t("users.none")}</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {missingUniqueCards.map((card) => (
                          <span
                            key={card.id}
                            className="rounded-md bg-rose-500/15 px-2 py-0.5 text-xs text-rose-200"
                          >
                            {card.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-gray-700 bg-gray-900 p-3">
                    <p className="mb-2 text-xs font-semibold text-emerald-300">
                      {t("users.ownedUniqueCards", { count: ownedUniqueCards.length })}
                    </p>
                    {ownedUniqueCards.length === 0 ? (
                      <p className="text-xs text-gray-500">{t("users.none")}</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {ownedUniqueCards.map((card) => (
                          <span
                            key={card.id}
                            className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-200"
                          >
                            {card.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="divide-y divide-gray-700 rounded-lg bg-gray-900">
                {panelHistory.length === 0 ? (
                  <div className="p-4 text-center text-gray-400">
                    {t("emptyMessage")}
                  </div>
                ) : (
                  panelHistory.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-3 p-3">
                      <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-lg bg-gray-700">
                        {entry.cards.image_url ? (
                          <Image
                            src={getOptimizedImageUrl(entry.cards.image_url, "icon")}
                            alt={entry.cards.name}
                            width={40}
                            height={40}
                            className="h-full w-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-lg">
                            🎴
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white">
                          {entry.cards.name}
                        </p>
                        <p className="text-xs text-gray-400">
                          {new Date(entry.redeemed_at).toLocaleString(locale)}
                        </p>
                      </div>
                      <div
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs text-white ${
                          RARITY_COLORS[entry.cards.rarity as Rarity]
                        }`}
                      >
                        {formatRarityLabel(entry.cards.rarity, tRarity)}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Panel pagination / パネル内ページネーション */}
              {panelPagination.totalPages > 1 && (
                <div className="mt-3">
                  <Pagination
                    currentPage={panelPagination.page}
                    totalPages={panelPagination.totalPages}
                    onPageChange={handlePanelPageChange}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
