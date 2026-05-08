"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { RARITY_COLORS } from "@/lib/constants";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import type { Rarity } from "@/types/database";

interface CardStat {
  cardId: string;
  cardName: string;
  rarity: string;
  imageUrl: string | null;
  configuredRate: number;
  actualCount: number;
  actualRate: number;
}

interface RarityStat {
  rarity: string;
  count: number;
  rate: number;
}

interface GachaStatsData {
  totalDraws: number;
  channelPointStats: {
    totalPoints: number;
    ranking: Array<{
      userTwitchId: string;
      username: string;
      totalPoints: number;
      redemptionCount: number;
      lastRedeemedAt: string | null;
    }>;
  };
  cardStats: CardStat[];
  rarityStats: RarityStat[];
}

type StatsTab = "7d" | "30d" | "channelPoints";

/**
 * Drop rate comparison table for streamer statistics page
 * Shows configured vs actual drop rates with deviation highlighting
 * 配信者統計ページ用の排出率比較テーブル
 * 設定排出率と実際の排出率を比較し、乖離をハイライト表示
 */
export default function DropRateTable() {
  const t = useTranslations("gachaStatsPage");
  const tRarity = useTranslations("rarity");

  const [activeTab, setActiveTab] = useState<StatsTab>("7d");
  const [stats, setStats] = useState<GachaStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const period = activeTab === "30d" ? "30d" : "7d";

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/gacha-stats?period=${period}`);
        if (res.ok) {
          const data = await res.json();
          setStats(data);
        }
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [period]);

  /**
   * Highlight rows where actual rate deviates significantly from configured rate
   * Threshold: >5 percentage points deviation
   * 設定率と実際の率の乖離が大きい行をハイライト
   * 閾値: 5ポイント以上の乖離
   */
  const getDeviationClass = (configured: number, actual: number): string => {
    if (configured === 0 && actual === 0) return "";
    const deviation = Math.abs(configured - actual);
    if (deviation > 5) return "bg-yellow-500/10";
    return "";
  };

  const renderChannelPointRanking = () => {
    if (!stats) return null;

    return (
      <div className="mb-6 overflow-hidden rounded-xl bg-gray-800">
        <div className="border-b border-gray-700 p-4">
          <h3 className="text-lg font-semibold text-white">
            {t("channelPointRanking.title")}
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            {t("channelPointRanking.total", {
              points: stats.channelPointStats.totalPoints.toLocaleString(),
            })}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {t("channelPointRanking.note")}
          </p>
        </div>
        {stats.channelPointStats.ranking.length === 0 ? (
          <div className="p-4 text-sm text-gray-400">
            {t("channelPointRanking.noData")}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 text-left text-gray-400">
                <th className="w-14 p-3 text-right">
                  {t("channelPointRanking.rank")}
                </th>
                <th className="p-3">{t("channelPointRanking.user")}</th>
                <th className="p-3 text-right">
                  {t("channelPointRanking.points")}
                </th>
                <th className="p-3 text-right">
                  {t("channelPointRanking.redemptions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {stats.channelPointStats.ranking.map((row, index) => (
                <tr key={row.userTwitchId}>
                  <td className="p-3 text-right font-medium text-gray-300">
                    {index + 1}
                  </td>
                  <td className="p-3 text-white">{row.username}</td>
                  <td className="p-3 text-right font-medium text-white">
                    {row.totalPoints.toLocaleString()}
                  </td>
                  <td className="p-3 text-right text-gray-300">
                    {row.redemptionCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  const renderPeriodStats = () => {
    if (!stats) return null;

    if (stats.totalDraws === 0) {
      return <div className="py-12 text-center text-gray-400">{t("noData")}</div>;
    }

    return (
      <>
        {/* Total draws summary / 総ガチャ回数サマリー */}
        <div className="mb-6 rounded-xl bg-gray-800 p-4 text-center">
          <div className="text-3xl font-bold text-white">
            {stats.totalDraws}
          </div>
          <div className="text-sm text-gray-400">
            {t("totalDraws")} ({t(`period.${period}`)})
          </div>
        </div>

        {/* Rarity summary / レアリティ別サマリー */}
        <h3 className="mb-3 text-lg font-semibold text-white">
          {t("raritySummary")}
        </h3>
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stats.rarityStats.map((rs) => (
            <div
              key={rs.rarity}
              className="rounded-xl bg-gray-800 p-4 text-center"
            >
              <div className="text-2xl font-bold text-white">{rs.count}</div>
              <div className="text-sm text-gray-400">
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-xs text-white ${
                    RARITY_COLORS[rs.rarity as Rarity]
                  }`}
                >
                  {tRarity(rs.rarity)}
                </span>
                <span className="ml-2">({rs.rate.toFixed(1)}%)</span>
              </div>
            </div>
          ))}
        </div>

        {/* Per-card drop rate table / カードごとの排出率テーブル */}
        <div className="overflow-x-auto rounded-xl bg-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 text-left text-gray-400">
                <th className="p-3">{t("dropRateTable.cardName")}</th>
                <th className="p-3">{t("dropRateTable.rarity")}</th>
                <th className="p-3 text-right">
                  {t("dropRateTable.configuredRate")}
                </th>
                <th className="p-3 text-right">
                  {t("dropRateTable.actualRate")}
                </th>
                <th className="p-3 text-right">
                  {t("dropRateTable.drawCount")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {stats.cardStats.map((card) => (
                <tr
                  key={card.cardId}
                  className={`${getDeviationClass(
                    card.configuredRate,
                    card.actualRate
                  )}`}
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 flex-shrink-0 overflow-hidden rounded bg-gray-700">
                        {card.imageUrl ? (
                          <Image
                            src={getOptimizedImageUrl(card.imageUrl, "icon")}
                            alt={card.cardName}
                            width={32}
                            height={32}
                            className="h-full w-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-sm">
                            🎴
                          </div>
                        )}
                      </div>
                      <span className="text-white">{card.cardName}</span>
                    </div>
                  </td>
                  <td className="p-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs text-white ${
                        RARITY_COLORS[card.rarity as Rarity]
                      }`}
                    >
                      {tRarity(card.rarity)}
                    </span>
                  </td>
                  <td className="p-3 text-right text-gray-300">
                    {card.configuredRate.toFixed(1)}%
                  </td>
                  <td className="p-3 text-right text-white font-medium">
                    {card.actualRate.toFixed(1)}%
                  </td>
                  <td className="p-3 text-right text-gray-300">
                    {card.actualCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  return (
    <div>
      {/* Period tabs / 期間タブ */}
      <div className="mb-6 flex flex-wrap gap-2">
        {(["7d", "30d", "channelPoints"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? "bg-purple-600 text-white"
                : "border border-gray-600 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {t(`tabs.${tab}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-12 text-center text-gray-400">
          <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-gray-500 border-t-purple-500" />
        </div>
      ) : !stats ? (
        <div className="py-12 text-center text-gray-400">{t("noData")}</div>
      ) : activeTab === "channelPoints" ? (
        renderChannelPointRanking()
      ) : (
        renderPeriodStats()
      )}

      {/* Full period stats notice / 全期間統計についてのお知らせ */}
      <div className="mt-8 rounded-xl border border-gray-700 bg-gray-800/50 p-4">
        <h4 className="mb-2 text-sm font-semibold text-gray-300">
          {t("fullPeriodStats.title")}
        </h4>
        <p className="text-sm text-gray-400">{t("fullPeriodStats.message")}</p>
      </div>
    </div>
  );
}
