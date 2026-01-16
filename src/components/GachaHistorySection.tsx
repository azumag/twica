"use client";

import { useState } from "react";
import Image from "next/image";
import type { GachaHistory, Card } from "@/types/database";
import { logger } from "@/lib/logger";

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

export default function GachaHistorySection({
  recentGacha,
  isStreamer,
}: GachaHistorySectionProps) {
  const [history, setHistory] = useState<GachaHistoryWithCard[]>(recentGacha);

  const handleDelete = async (historyId: string) => {
    if (!confirm("この記録を削除しますか？")) return;

    try {
      const response = await fetch(`/api/gacha-history/${historyId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        setHistory(history.filter((h: GachaHistoryWithCard) => h.id !== historyId));
      }
    } catch (error) {
      logger.error("Failed to delete gacha history:", error);
    }
  };

  return (
    <section className="mb-12">
      <h2 className="mb-6 text-2xl font-semibold text-white">最近の獲得情報</h2>
      <div className="overflow-hidden rounded-xl bg-gray-800">
        <div className="divide-y divide-gray-700">
          {history.length === 0 ? (
            <div className="p-6 text-center text-gray-400">
              まだ獲得情報はありません。
            </div>
          ) : (
            history.map((entry: GachaHistoryWithCard) => (
              <div key={entry.id} className="flex items-center gap-4 p-4">
                <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-lg bg-gray-700">
                  {entry.cards.image_url ? (
                    <Image
                      src={entry.cards.image_url}
                      alt={entry.cards.name}
                      width={48}
                      height={48}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xl">
                      🎴
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">
                    <span className="text-purple-400 font-bold">{entry.user_twitch_username}</span> が
                    <span className="text-white font-bold ml-1">{entry.cards.name}</span> を獲得しました！
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
                    削除
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