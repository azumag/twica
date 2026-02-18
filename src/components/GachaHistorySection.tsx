"use client";

import { useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { GachaHistory, Card } from "@/types/database";
import { logger } from "@/lib/logger";
import { getOptimizedImageUrl } from "@/lib/image-utils";


interface GachaHistoryWithCard extends GachaHistory {
  cards: Card;
}

interface GachaHistorySectionProps {
  recentGacha: GachaHistoryWithCard[];
  isStreamer: boolean;
}

const RARITY_COLORS = {
  common: "bg-gray-500",
  rare: "bg-blue-500",
  epic: "bg-purple-500",
  legendary: "bg-yellow-500",
};

/**
 * Gacha History Section Component
 * Displays recent card acquisitions with optional delete functionality for streamers
 * ガチャ履歴セクションコンポーネント - 配信者向けの削除機能付きで最近のカード獲得を表示
 */
export default function GachaHistorySection({
  recentGacha,
  isStreamer,
}: GachaHistorySectionProps) {
  const t = useTranslations("gachaHistory");
  const tCard = useTranslations("cardManager");
  const tCommon = useTranslations("common");
  const [history, setHistory] = useState<GachaHistoryWithCard[]>(recentGacha);

  const handleDelete = async (historyId: string) => {
    if (!confirm(tCard("confirmations.deleteCard"))) return;

    try {
      const response = await fetch(`/api/gacha-history/${historyId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        setHistory(history.filter((h: GachaHistoryWithCard) => h.id !== historyId));
      } else if (response.status === 429) {
        const errorData = await response.json();
        alert(tCard("messages.operationFailed", { msg: errorData.error || tCard("messages.rateLimit") }));
        logger.error("Rate limit exceeded:", errorData);
      }
    } catch (error) {
      logger.error("Failed to delete gacha history:", error);
    }
  };

  return (
    <section className="mb-12">
      <h2 className="mb-6 text-2xl font-semibold text-white">{t("title")}</h2>
      <div className="overflow-hidden rounded-xl bg-gray-800">
        <div className="divide-y divide-gray-700">
          {history.length === 0 ? (
            <div className="p-6 text-center text-gray-400">
              {t("emptyMessage")}
            </div>
          ) : (
            history.map((entry: GachaHistoryWithCard) => (
              <div key={entry.id} className="flex items-center gap-4 p-4">
                <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-gray-700">
                  {entry.cards.image_url ? (
                    <Image
                      src={getOptimizedImageUrl(entry.cards.image_url, "icon")}
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
                 <div className="flex-1 min-w-0">
                   <p className="text-sm font-medium text-white">
                     {t("got", { username: entry.user_twitch_username || t("unknown"), cardName: entry.cards.name })}
                   </p>
                   <p className="text-xs text-gray-500">
                     {new Date(entry.redeemed_at).toLocaleString('ja-JP')}
                   </p>
                 </div>
                 <div className={`rounded-full px-2 py-0.5 text-xs text-white ${RARITY_COLORS[entry.cards.rarity]}`}>
                   {entry.cards.rarity}
                 </div>
                 {isStreamer && (
                   <button
                     onClick={() => handleDelete(entry.id)}
                     className="rounded bg-red-500 px-3 py-1 text-xs text-white hover:bg-red-600 transition-colors"
                   >
                     {tCommon("delete")}
                   </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}