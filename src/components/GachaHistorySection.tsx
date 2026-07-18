"use client";

import { useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { GachaHistory, Card } from "@/types/database";
import { logger } from "@/lib/logger";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { getRarityColorClass } from "@/lib/rarity";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";


interface GachaHistoryWithCard extends GachaHistory {
  cards: Card;
}

interface GachaHistorySectionProps {
  recentGacha: GachaHistoryWithCard[];
  isStreamer: boolean;
}

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
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6c: ダッシュボード共有Context経由のmaintenance状態。
  // 削除のたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";
  const [history, setHistory] = useState<GachaHistoryWithCard[]>(recentGacha);
  // 削除処理中のアイテムIDを保持し、連続クリックを防止
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (historyId: string) => {
    // 別の削除処理が進行中の場合はスキップ
    if (deletingId) return;
    if (!confirm(tCard("confirmations.deleteCard"))) return;

    // ボタン自体はdisableしているが、CardManager.handleSubmitと同じ方針で
    // 送信経路の先頭でも二重にガードする。
    if (isMaintenanceBlocked) {
      alert(tMaintenance("writeDisabled"));
      return;
    }

    setDeletingId(historyId);
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
      } else {
        // maintenance mode による503拒否ならサーバーの案内文言を優先する
        // （事前disableをすり抜けた場合のフォールバック表示）。
        const errorData = await response.json().catch(() => ({}));
        const maintenanceError = parseMaintenanceError(response, errorData);
        alert(tCard("messages.operationFailed", { msg: maintenanceError?.message || `HTTP ${response.status}` }));
      }
    } catch (error) {
      logger.error("Failed to delete gacha history:", error);
      alert(tCard("messages.operationFailed", { msg: String(error) }));
    } finally {
      setDeletingId(null);
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
                 <div className={`rounded-full px-2 py-0.5 text-xs text-white ${getRarityColorClass(entry.cards.rarity)}`}>
                   {entry.cards.rarity}
                 </div>
                 {isStreamer && (
                   <button
                     onClick={() => handleDelete(entry.id)}
                     disabled={deletingId !== null || isMaintenanceBlocked}
                     title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                     className="rounded bg-red-500 px-3 py-1 text-xs text-white hover:bg-red-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                   >
                     {deletingId === entry.id ? "..." : tCommon("delete")}
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
