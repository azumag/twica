"use client";

import { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { Card, Rarity } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import { formatRarityLabel, getRarityDisplayInfo } from "@/lib/rarity";
import { logger } from "@/lib/logger";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { parseMaintenanceError } from "@/lib/maintenance/client";
import { useMaintenanceStatus } from "./MaintenanceStatusProvider";

interface BatchDropRateManualContentProps {
  onClose: () => void;
  cards: Card[];
  streamerId: string;
  onSave: (updatedCards: Card[]) => void;
  onSwitchToAutoMode: () => void;
}

type TabType = "individual" | "rarity";

/**
 * BatchDropRateManualContent - 手動モード用の確率一括調整コンテンツ
 *
 * 個別カードの drop_rate を直接操作する。
 * - 個別調整タブ: カードごとにdrop_rateスライダー
 * - レアリティ別タブ: レアリティ単位で一括調整
 * - 確率 = dropRate / totalWeight * 100（重み比率方式）
 */
export default function BatchDropRateManualContent({
  onClose,
  cards,
  streamerId,
  onSave,
  onSwitchToAutoMode,
}: BatchDropRateManualContentProps) {
  const t = useTranslations("cardManager");
  const tRarity = useTranslations("rarity");
  const tCommon = useTranslations("common");
  const tMaintenance = useTranslations("maintenance");
  // #694 Stage 6b: ダッシュボード共有Context経由のmaintenance状態。
  // 保存ボタンのたびに個別fetchしない設計（MaintenanceStatusProvider参照）。
  const { mode: maintenanceMode } = useMaintenanceStatus();
  const isMaintenanceBlocked = maintenanceMode !== "off";

  const [activeTab, setActiveTab] = useState<TabType>("rarity");
  const [localDropRates, setLocalDropRates] = useState<Map<string, number>>(new Map());
  const [rarityMultipliers, setRarityMultipliers] = useState<Map<Rarity, number>>(new Map());
  const [initialRarityMultipliers, setInitialRarityMultipliers] = useState<Map<Rarity, number>>(new Map());
  const [saving, setSaving] = useState(false);

  const activeCards = useMemo(() => cards.filter(card => card.is_active), [cards]);

  // アクティブカードからローカルドロップレートとレアリティ倍率を初期化
  useEffect(() => {
    const initialRates = new Map<string, number>();
    activeCards.forEach(card => {
      initialRates.set(card.id, card.drop_rate);
    });
    setLocalDropRates(initialRates);

    const initialMultipliers = new Map<Rarity, number>();
    RARITIES.forEach(r => {
      const rarityCards = activeCards.filter(c => c.rarity === r.value);
      if (rarityCards.length > 0) {
        const avgRate = rarityCards.reduce((sum, c) => sum + c.drop_rate, 0) / rarityCards.length;
        initialMultipliers.set(r.value, avgRate);
      } else {
        initialMultipliers.set(r.value, 1.0);
      }
    });
    setRarityMultipliers(initialMultipliers);
    setInitialRarityMultipliers(new Map(initialMultipliers));
    setActiveTab("rarity");
  }, [activeCards]);

  // レアリティごとのカード統計を計算
  const rarityStats = useMemo(() => {
    const stats = new Map<Rarity, { cards: Card[]; originalWeight: number; currentWeight: number }>();
    RARITIES.forEach(r => {
      const rarityCards = activeCards.filter(c => c.rarity === r.value);
      const originalWeight = rarityCards.reduce((sum, c) => sum + c.drop_rate, 0);
      const multiplier = rarityMultipliers.get(r.value) ?? 1.0;
      // カード数×倍率で合計重みを算出
      const currentWeight = rarityCards.length * multiplier;
      stats.set(r.value, { cards: rarityCards, originalWeight, currentWeight });
    });
    return stats;
  }, [activeCards, rarityMultipliers]);

  // 合計重みを計算（重み比率方式）
  const totalWeight = useMemo(() => {
    if (activeTab === "individual") {
      return activeCards.reduce((sum, card) => {
        const rate = localDropRates.get(card.id) ?? card.drop_rate;
        return sum + rate;
      }, 0);
    } else {
      let total = 0;
      rarityStats.forEach(stat => { total += stat.currentWeight; });
      return total;
    }
  }, [activeTab, activeCards, localDropRates, rarityStats]);

  // 指定された出現重みから実際の確率を計算
  const calculateProbability = (dropRate: number): number => {
    if (totalWeight === 0) return 0;
    return (dropRate / totalWeight) * 100;
  };

  // 変更があるかどうかをチェック
  const hasChanges = useMemo(() => {
    for (const card of activeCards) {
      const localRate = localDropRates.get(card.id);
      if (localRate !== undefined && Math.abs(localRate - card.drop_rate) > 0.001) {
        return true;
      }
    }
    for (const [rarity, multiplier] of rarityMultipliers) {
      const initial = initialRarityMultipliers.get(rarity) ?? 1.0;
      if (Math.abs(multiplier - initial) > 0.001) {
        return true;
      }
    }
    return false;
  }, [activeCards, localDropRates, rarityMultipliers, initialRarityMultipliers]);

  // 変更されたカードIDを取得（個別モード用ハイライト）
  const modifiedCardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of activeCards) {
      const localRate = localDropRates.get(card.id);
      if (localRate !== undefined && Math.abs(localRate - card.drop_rate) > 0.001) {
        ids.add(card.id);
      }
    }
    return ids;
  }, [activeCards, localDropRates]);

  // 変更されたレアリティを取得（レアリティモード用ハイライト）
  const modifiedRarities = useMemo(() => {
    const rarities = new Set<Rarity>();
    for (const [rarity, multiplier] of rarityMultipliers) {
      const initial = initialRarityMultipliers.get(rarity) ?? 1.0;
      if (Math.abs(multiplier - initial) > 0.001) {
        rarities.add(rarity);
      }
    }
    return rarities;
  }, [rarityMultipliers, initialRarityMultipliers]);

  const handleDropRateChange = (cardId: string, value: number) => {
    setLocalDropRates(prev => {
      const next = new Map(prev);
      next.set(cardId, value);
      return next;
    });
  };

  const handleRarityMultiplierChange = (rarity: Rarity, multiplier: number) => {
    setRarityMultipliers(prev => {
      const next = new Map(prev);
      next.set(rarity, multiplier);
      return next;
    });
  };

  // 全カードの重みを1.0にリセット
  const handleResetAll = () => {
    setLocalDropRates(prev => {
      const next = new Map(prev);
      activeCards.forEach(card => { next.set(card.id, 1.0); });
      return next;
    });
    setRarityMultipliers(prev => {
      const next = new Map(prev);
      RARITIES.forEach(r => { next.set(r.value, 1.0); });
      return next;
    });
  };

  // 特定レアリティの全カードの重みを1.0にリセット
  const handleResetRarity = (rarity: Rarity) => {
    setLocalDropRates(prev => {
      const next = new Map(prev);
      activeCards.filter(card => card.rarity === rarity).forEach(card => { next.set(card.id, 1.0); });
      return next;
    });
    setRarityMultipliers(prev => {
      const next = new Map(prev);
      next.set(rarity, 1.0);
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
      const updates: Array<{ id: string; dropRate: number }> = [];
      const addedCardIds = new Set<string>();

      // localDropRatesが直接変更されたカードを追加
      for (const card of activeCards) {
        const localRate = localDropRates.get(card.id);
        if (localRate !== undefined && Math.abs(localRate - card.drop_rate) > 0.001) {
          updates.push({ id: card.id, dropRate: localRate });
          addedCardIds.add(card.id);
        }
      }

      // レアリティ重み変更からのカードを追加（未追加のもの）
      if (activeTab === "rarity") {
        for (const [rarity, multiplier] of rarityMultipliers) {
          const initial = initialRarityMultipliers.get(rarity) ?? 1.0;
          if (Math.abs(multiplier - initial) > 0.001) {
            const rarityCards = activeCards.filter(c => c.rarity === rarity);
            for (const card of rarityCards) {
              if (addedCardIds.has(card.id)) continue;
              const newRate = Math.min(1, Math.max(0, multiplier));
              updates.push({ id: card.id, dropRate: newRate });
              addedCardIds.add(card.id);
            }
          }
        }
      }

      if (updates.length === 0) { onClose(); return; }

      const response = await fetch("/api/cards/batch-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ streamerId, updates }),
      });

      if (!response.ok) {
        const error = await response.json();
        // maintenance mode による503拒否ならサーバーの案内文言を優先する
        // （事前disableをすり抜けた場合＝ポーリング間隔中に切り替わった等の
        // フォールバック表示。#694 Stage 6bの要求「fetch失敗時のエラー表示」）。
        const maintenanceError = parseMaintenanceError(response, error);
        throw new Error(maintenanceError?.message || error.error || t("batchDropRate.saveFailed"));
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

  const getRarityInfo = (rarity: Rarity) => getRarityDisplayInfo(rarity);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={handleClose}>
      <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* ヘッダー */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">{t("dropRateSettings.title")}</h3>
            <button onClick={handleClose} className="text-gray-400 hover:text-white" aria-label="Close">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* タブ */}
          <div className="mt-4 flex border-b border-gray-700">
            <button
              onClick={() => setActiveTab("rarity")}
              className={`px-4 py-2 text-sm font-medium transition ${
                activeTab === "rarity" ? "text-purple-400 border-b-2 border-purple-400" : "text-gray-400 hover:text-white"
              }`}
            >
              {t("batchDropRate.tabRarity")}
            </button>
            <button
              onClick={() => setActiveTab("individual")}
              className={`px-4 py-2 text-sm font-medium transition ${
                activeTab === "individual" ? "text-purple-400 border-b-2 border-purple-400" : "text-gray-400 hover:text-white"
              }`}
            >
              {t("batchDropRate.tabIndividual")}
            </button>
          </div>

          {/* サマリーバー */}
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
                      {activeTab === "individual"
                        ? `${modifiedCardIds.size} ${t("batchDropRate.cardsModified")}`
                        : `${modifiedRarities.size} ${t("batchDropRate.raritiesModified")}`}
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
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeCards.length === 0 ? (
            <p className="text-center text-gray-400">{t("batchDropRate.noActiveCards")}</p>
          ) : activeTab === "individual" ? (
            <div className="space-y-3">
              {activeCards.map((card) => {
                const rarityInfo = getRarityInfo(card.rarity);
                const currentRate = localDropRates.get(card.id) ?? card.drop_rate;
                const probability = calculateProbability(currentRate);
                const isModified = modifiedCardIds.has(card.id);

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
                          {formatRarityLabel(card.rarity, tRarity)}
                        </span>
                      </div>
                    </div>

                    {/* drop_rateスライダー */}
                    <div className="flex-1 flex flex-col sm:flex-row items-start sm:items-center gap-3">
                      <div className="flex-1 w-full">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={currentRate}
                          onChange={(e) => handleDropRateChange(card.id, parseFloat(e.target.value))}
                          className="w-full"
                        />
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs text-gray-500">{t("batchDropRate.overallDropRate")}</span>
                        <span className={`text-sm font-medium ${isModified ? "text-yellow-400" : "text-green-400"}`}>
                          {probability.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* レアリティ別調整タブ */
            <div className="space-y-4">
              <p className="text-sm text-gray-400 mb-4">{t("batchDropRate.rarityDescription")}</p>
              {RARITIES.map((rarityConfig) => {
                const rarity = rarityConfig.value;
                const stats = rarityStats.get(rarity);
                if (!stats || stats.cards.length === 0) return null;

                const multiplier = rarityMultipliers.get(rarity) ?? 1.0;
                const isModified = modifiedRarities.has(rarity);
                const rarityProbability = totalWeight > 0 ? (stats.currentWeight / totalWeight) * 100 : 0;

                return (
                  <div
                    key={rarity}
                    className={`rounded-lg p-4 transition ${
                      isModified ? "bg-yellow-900/30 border border-yellow-600/50" : "bg-gray-700"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <span className={`rounded-full px-3 py-1 text-sm font-medium text-white ${rarityConfig.color}`}>
                          {formatRarityLabel(rarity, tRarity)}
                        </span>
                        <span className="text-sm text-gray-400">
                          {stats.cards.length} {t("batchDropRate.cardsCount")}
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <button
                          type="button"
                          onClick={() => handleResetRarity(rarity)}
                          className="rounded border border-orange-500 px-2 py-0.5 text-xs text-orange-400 hover:bg-orange-500 hover:text-white transition"
                          title={t("batchDropRate.resetTooltip")}
                        >
                          {t("batchDropRate.resetRarity")}
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                      <div className="flex-1 w-full">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={multiplier}
                          onChange={(e) => handleRarityMultiplierChange(rarity, parseFloat(e.target.value))}
                          className="w-full"
                        />
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs text-gray-500">{t("batchDropRate.overallDropRate")}</span>
                        <span className={`text-sm font-medium ${isModified ? "text-yellow-400" : "text-green-400"}`}>
                          {rarityProbability.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="p-6 border-t border-gray-700 bg-gray-800/50">
          {isMaintenanceBlocked && (
            <p className="mb-3 text-sm text-yellow-400">{tMaintenance("writeDisabled")}</p>
          )}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                // 未保存変更がある場合は確認（モード切替で変更が失われるため）
                if (hasChanges && !confirm(t("batchDropRate.confirmClose"))) return;
                onSwitchToAutoMode();
              }}
              className="text-sm text-gray-400 hover:text-white transition text-left"
            >
              {t("dropRateSettings.switchToAuto")}
            </button>
            <div className="flex justify-end gap-3">
              <button
                onClick={handleClose}
                className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
              >
                {tCommon("cancel")}
              </button>
              <button
                onClick={handleSave}
                disabled={!hasChanges || saving || isMaintenanceBlocked}
                title={isMaintenanceBlocked ? tMaintenance("writeDisabled") : undefined}
                className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? t("batchDropRate.saving") : t("batchDropRate.save")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
