"use client";

import { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { Card, Rarity } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { getOptimizedImageUrl } from "@/lib/image-utils";

interface BatchDropRateAutoContentProps {
  onClose: () => void;
  cards: Card[];
  streamerId: string;
  onSave: (updatedCards: Card[]) => void;
  warningMessage?: string;
  // 自動モード時のレアリティ別確率設定（確率プレビュー表示用）
  rarityWeights: Record<string, number>;
}

/**
 * BatchDropRateAutoContent - 自動計算モード用の確率一括調整コンテンツ
 *
 * intra_rarity_weight のみを操作し、drop_rate はサーバーで再計算。
 * 確率プレビューはサーバー計算式と一致:
 *   card_rate = (rarity_pct / 100) * (intra_weight / total_intra_weight_in_rarity)
 *
 * タブなし（個別調整のみ）。レアリティ確率はサーバー設定で決定されるため。
 */
export default function BatchDropRateAutoContent({
  onClose,
  cards,
  streamerId,
  onSave,
  warningMessage,
  rarityWeights,
}: BatchDropRateAutoContentProps) {
  const t = useTranslations("cardManager");
  const tRarity = useTranslations("rarity");
  const tCommon = useTranslations("common");

  const [localIntraWeights, setLocalIntraWeights] = useState<Map<string, number>>(new Map());
  const [saving, setSaving] = useState(false);

  const activeCards = useMemo(() => cards.filter(card => card.is_active), [cards]);

  // レアリティ内重みを初期化
  useEffect(() => {
    const initial = new Map<string, number>();
    activeCards.forEach(card => {
      initial.set(card.id, card.intra_rarity_weight ?? 1.0);
    });
    setLocalIntraWeights(initial);
  }, [activeCards]);

  // 変更があるかどうかをチェック
  const hasChanges = useMemo(() => {
    for (const card of activeCards) {
      const localWeight = localIntraWeights.get(card.id);
      const originalWeight = card.intra_rarity_weight ?? 1.0;
      if (localWeight !== undefined && Math.abs(localWeight - originalWeight) > 0.001) {
        return true;
      }
    }
    return false;
  }, [activeCards, localIntraWeights]);

  // 変更されたカードIDを取得（ハイライト用）
  const modifiedCardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of activeCards) {
      const localWeight = localIntraWeights.get(card.id);
      const originalWeight = card.intra_rarity_weight ?? 1.0;
      if (localWeight !== undefined && Math.abs(localWeight - originalWeight) > 0.001) {
        ids.add(card.id);
      }
    }
    return ids;
  }, [activeCards, localIntraWeights]);

  // レアリティごとのintra weight合計を計算（確率プレビュー用）
  const rarityIntraTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const card of activeCards) {
      const weight = localIntraWeights.get(card.id) ?? (card.intra_rarity_weight ?? 1.0);
      const current = totals.get(card.rarity) ?? 0;
      totals.set(card.rarity, current + weight);
    }
    return totals;
  }, [activeCards, localIntraWeights]);

  // 全カードのintraRarityWeightを1.0にリセット（drop_rateは操作しない）
  const handleResetAll = () => {
    setLocalIntraWeights(prev => {
      const next = new Map(prev);
      activeCards.forEach(card => { next.set(card.id, 1.0); });
      return next;
    });
  };

  // 未保存の変更がある場合は確認ダイアログを表示してクローズ
  const handleClose = () => {
    if (hasChanges && !confirm(t("batchDropRate.confirmClose"))) return;
    onClose();
  };

  const handleSave = async () => {
    if (!hasChanges) return;
    setSaving(true);
    try {
      const csrfToken = document.cookie
        .split("; ")
        .find(row => row.startsWith("csrf_token="))
        ?.split("=")[1];

      // intraRarityWeight変更のみをupdatesに追加
      // drop_rateは現在の値をそのまま送信（サーバー側で再計算）
      const updates: Array<{ id: string; dropRate: number; intraRarityWeight: number }> = [];
      for (const card of activeCards) {
        const localWeight = localIntraWeights.get(card.id);
        const originalWeight = card.intra_rarity_weight ?? 1.0;
        if (localWeight !== undefined && Math.abs(localWeight - originalWeight) > 0.001) {
          updates.push({
            id: card.id,
            dropRate: card.drop_rate,
            intraRarityWeight: localWeight,
          });
        }
      }

      if (updates.length === 0) { onClose(); return; }

      const response = await fetch("/api/cards/batch-update", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
        credentials: "include",
        body: JSON.stringify({ streamerId, updates }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t("batchDropRate.saveFailed"));
      }

      const result = await response.json();
      if (result.cards) {
        let allUpdatedCards = result.cards as Card[];
        if (Array.isArray(result.recalculatedCards)) {
          const recalculatedMap = new Map(
            (result.recalculatedCards as Card[]).map(c => [c.id, c])
          );
          allUpdatedCards = allUpdatedCards.map(c => recalculatedMap.get(c.id) || c);
          for (const rc of result.recalculatedCards as Card[]) {
            if (!allUpdatedCards.some(c => c.id === rc.id)) {
              allUpdatedCards.push(rc);
            }
          }
        }
        onSave(allUpdatedCards);
      }
      onClose();
    } catch (error) {
      logger.error("Failed to batch update drop rates:", error);
      alert(error instanceof Error ? error.message : t("batchDropRate.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const getRarityInfo = (rarity: Rarity) =>
    RARITIES.find((r) => r.value === rarity) || RARITIES[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={handleClose}>
      <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* ヘッダー */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">{t("batchDropRate.title")}</h3>
            <button onClick={handleClose} className="text-gray-400 hover:text-white" aria-label="Close">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* サマリーバー: totalWeightの代わりにカード数と変更件数を表示 */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-gray-400">{t("batchDropRate.activeCards")}:</span>
                <span className="text-white font-medium">{activeCards.length}</span>
              </div>
              {hasChanges && (
                <>
                  <div className="h-4 w-px bg-gray-600" />
                  <div className="flex items-center gap-2">
                    <span className="text-yellow-400">
                      {modifiedCardIds.size} {t("batchDropRate.cardsModified")}
                    </span>
                  </div>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={handleResetAll}
              className="rounded-lg border border-orange-500 px-3 py-1 text-sm text-orange-400 hover:bg-orange-500 hover:text-white transition"
            >
              {t("batchDropRate.resetAll")}
            </button>
          </div>
          {warningMessage && (
            <div className="mt-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
              {warningMessage}
            </div>
          )}
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeCards.length === 0 ? (
            <p className="text-center text-gray-400">{t("batchDropRate.noActiveCards")}</p>
          ) : (
            <div className="space-y-3">
              {activeCards.map((card) => {
                const rarityInfo = getRarityInfo(card.rarity);
                const currentWeight = localIntraWeights.get(card.id) ?? (card.intra_rarity_weight ?? 1.0);
                const isModified = modifiedCardIds.has(card.id);

                // サーバー計算式と一致する確率プレビュー
                // card_rate = (rarity_pct / 100) * (intra_weight / total_intra_weight_in_rarity)
                const targetPercent = rarityWeights[card.rarity] ?? 0;
                const sameRarityTotal = rarityIntraTotals.get(card.rarity) ?? 0;
                const intraPercent = sameRarityTotal > 0 ? (currentWeight / sameRarityTotal) * 100 : 0;
                const overallPercent = sameRarityTotal > 0
                  ? (targetPercent / 100) * (currentWeight / sameRarityTotal) * 100
                  : 0;

                return (
                  <div
                    key={card.id}
                    className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg p-3 transition ${
                      isModified ? "bg-yellow-900/30 border border-yellow-600/50" : "bg-gray-700"
                    }`}
                  >
                    {/* カード情報 */}
                    <div className="flex items-center gap-3 min-w-0 sm:w-48 shrink-0">
                      <div className="w-10 h-10 rounded bg-gray-600 overflow-hidden shrink-0">
                        {card.image_url ? (
                          <Image
                            src={getOptimizedImageUrl(card.image_url, "icon")}
                            alt={card.name}
                            width={40}
                            height={40}
                            className="w-full h-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs">
                            {tCommon("noImage")}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white truncate">{card.name}</p>
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs text-white ${rarityInfo.color}`}>
                          {tRarity(card.rarity)}
                        </span>
                      </div>
                    </div>

                    {/* intra-rarity weightスライダー */}
                    <div className="flex-1 flex flex-col sm:flex-row items-start sm:items-center gap-3">
                      <div className="flex-1 w-full">
                        <input
                          type="range"
                          min="0.1"
                          max="10"
                          step="0.1"
                          value={currentWeight}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            setLocalIntraWeights(prev => {
                              const next = new Map(prev);
                              next.set(card.id, val);
                              return next;
                            });
                          }}
                          className="w-full"
                        />
                      </div>
                      {/* 確率プレビュー */}
                      {targetPercent > 0 && (
                        <div className="flex items-center gap-2 text-sm shrink-0">
                          <span className="text-xs text-gray-500">{t("batchDropRate.overallDropRate")}</span>
                          <span className={`font-medium ${isModified ? "text-yellow-400" : "text-green-400"}`}>
                            {overallPercent.toFixed(1)}%
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="p-6 border-t border-gray-700 bg-gray-800/50">
          <div className="flex justify-end gap-3">
            <button
              onClick={handleClose}
              className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
            >
              {tCommon("cancel")}
            </button>
            <button
              onClick={handleSave}
              disabled={!hasChanges || saving}
              className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? t("batchDropRate.saving") : t("batchDropRate.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
