"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

interface GachaHistoryFiltersProps {
  onFilterChange: (filters: {
    username?: string;
    rarity?: string;
    cardId?: string;
    from?: string;
    to?: string;
  }) => void;
  /** Available cards for card name filter / カード名フィルタ用のカード一覧 */
  cards?: { id: string; name: string }[];
}

/**
 * Filter controls for streamer gacha history page
 * Provides username search, rarity selection, card name filter, and date range inputs
 * 配信者向けガチャ履歴フィルタコントロール
 * ユーザー名検索、レアリティ選択、カード名フィルタ、期間指定の入力を提供
 */
export default function GachaHistoryFilters({
  onFilterChange,
  cards,
}: GachaHistoryFiltersProps) {
  const t = useTranslations("gachaHistoryPage");
  const tRarity = useTranslations("rarity");

  const [username, setUsername] = useState("");
  const [rarity, setRarity] = useState("");
  const [cardId, setCardId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const handleApply = () => {
    onFilterChange({
      username: username || undefined,
      rarity: rarity || undefined,
      cardId: cardId || undefined,
      from: from || undefined,
      to: to || undefined,
    });
  };

  const handleReset = () => {
    setUsername("");
    setRarity("");
    setCardId("");
    setFrom("");
    setTo("");
    onFilterChange({});
  };

  return (
    <div className="mb-6 rounded-xl bg-gray-800 p-4">
      <div className={`grid gap-3 sm:grid-cols-2 ${cards && cards.length > 0 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
        {/* Username search / ユーザー名検索 */}
        <div>
          <label className="mb-1 block text-xs text-gray-400">
            {t("filters.username")}
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("filters.usernamePlaceholder")}
            className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-400 focus:border-purple-500 focus:outline-none"
          />
        </div>

        {/* Rarity select / レアリティ選択 */}
        <div>
          <label className="mb-1 block text-xs text-gray-400">
            {t("filters.rarity")}
          </label>
          <select
            value={rarity}
            onChange={(e) => setRarity(e.target.value)}
            className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none"
          >
            <option value="">{t("filters.allRarities")}</option>
            <option value="legendary">{tRarity("legendary")}</option>
            <option value="epic">{tRarity("epic")}</option>
            <option value="rare">{tRarity("rare")}</option>
            <option value="common">{tRarity("common")}</option>
          </select>
        </div>

        {/* Card name select / カード名フィルタ */}
        {cards && cards.length > 0 && (
          <div>
            <label className="mb-1 block text-xs text-gray-400">
              {t("filters.cardName")}
            </label>
            <select
              value={cardId}
              onChange={(e) => setCardId(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none"
            >
              <option value="">{t("filters.allCards")}</option>
              {cards.map((card) => (
                <option key={card.id} value={card.id}>
                  {card.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Date from / 開始日 */}
        <div>
          <label className="mb-1 block text-xs text-gray-400">
            {t("filters.from")}
          </label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none"
          />
        </div>

        {/* Date to / 終了日 */}
        <div>
          <label className="mb-1 block text-xs text-gray-400">
            {t("filters.to")}
          </label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Action buttons / アクションボタン */}
      <div className="mt-3 flex gap-2">
        <button
          onClick={handleApply}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 transition-colors"
        >
          {t("filters.apply")}
        </button>
        <button
          onClick={handleReset}
          className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700 transition-colors"
        >
          {t("filters.reset")}
        </button>
      </div>
    </div>
  );
}
