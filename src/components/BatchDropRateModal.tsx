"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { Card, Rarity } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import { logger } from "@/lib/logger";

interface BatchDropRateModalProps {
  isOpen: boolean;
  onClose: () => void;
  cards: Card[];
  streamerId: string;
  onSave: (updatedCards: Card[]) => void;
}

// Tab type for switching between individual and rarity-based adjustment
// 個別調整とレアリティ別調整を切り替えるためのタブ型
type TabType = "individual" | "rarity";

/**
 * BatchDropRateModal - Modal for batch editing drop rates of all active cards
 * 確率一括調整モーダル - 全アクティブカードの出現確率を一括編集するモーダル
 *
 * Features:
 * - Displays only active cards (is_active=true) since inactive cards don't affect probability
 * - Real-time probability calculation as weights change
 * - Visual highlighting of modified cards
 * - Confirmation dialog when closing with unsaved changes
 */
export default function BatchDropRateModal({
  isOpen,
  onClose,
  cards,
  streamerId,
  onSave,
}: BatchDropRateModalProps) {
  const t = useTranslations("cardManager");
  const tRarity = useTranslations("rarity");
  const tCommon = useTranslations("common");

  // Current tab state (default to rarity view)
  // 現在のタブ状態（デフォルトはレアリティ表示）
  const [activeTab, setActiveTab] = useState<TabType>("rarity");

  // Local state for tracking drop rate changes (individual mode)
  // ドロップレート変更を追跡するローカル状態（個別モード）
  const [localDropRates, setLocalDropRates] = useState<Map<string, number>>(new Map());

  // Local state for tracking rarity weight multipliers (rarity mode)
  // レアリティ重み倍率を追跡するローカル状態（レアリティモード）
  const [rarityMultipliers, setRarityMultipliers] = useState<Map<Rarity, number>>(new Map());

  const [saving, setSaving] = useState(false);

  // Filter to show only active cards
  // アクティブカードのみをフィルタリングして表示
  const activeCards = useMemo(() => {
    return cards.filter(card => card.is_active);
  }, [cards]);

  // Initialize local drop rates and rarity multipliers from active cards
  // アクティブカードからローカルドロップレートとレアリティ倍率を初期化
  useEffect(() => {
    if (isOpen) {
      // Initialize individual drop rates
      // 個別のドロップレートを初期化
      const initialRates = new Map<string, number>();
      activeCards.forEach(card => {
        initialRates.set(card.id, card.drop_rate);
      });
      setLocalDropRates(initialRates);

      // Initialize rarity multipliers to 1.0 (no change)
      // レアリティ倍率を1.0（変更なし）で初期化
      const initialMultipliers = new Map<Rarity, number>();
      RARITIES.forEach(r => {
        initialMultipliers.set(r.value, 1.0);
      });
      setRarityMultipliers(initialMultipliers);

      // Reset to rarity tab (default view)
      // レアリティタブにリセット（デフォルト表示）
      setActiveTab("rarity");
    }
  }, [isOpen, activeCards]);

  // Calculate cards by rarity with their statistics
  // レアリティごとのカード統計を計算
  const rarityStats = useMemo(() => {
    const stats = new Map<Rarity, { cards: Card[]; originalWeight: number; currentWeight: number }>();

    RARITIES.forEach(r => {
      const rarityCards = activeCards.filter(c => c.rarity === r.value);
      const originalWeight = rarityCards.reduce((sum, c) => sum + c.drop_rate, 0);
      const multiplier = rarityMultipliers.get(r.value) ?? 1.0;
      const currentWeight = originalWeight * multiplier;

      stats.set(r.value, {
        cards: rarityCards,
        originalWeight,
        currentWeight,
      });
    });

    return stats;
  }, [activeCards, rarityMultipliers]);

  // Calculate total weight based on active tab mode
  // アクティブなタブモードに基づいて合計重みを計算
  const totalWeight = useMemo(() => {
    if (activeTab === "individual") {
      return activeCards.reduce((sum, card) => {
        const rate = localDropRates.get(card.id) ?? card.drop_rate;
        return sum + rate;
      }, 0);
    } else {
      // Rarity mode: sum of all rarity weights with multipliers applied
      // レアリティモード: 倍率を適用した全レアリティ重みの合計
      let total = 0;
      rarityStats.forEach(stat => {
        total += stat.currentWeight;
      });
      return total;
    }
  }, [activeTab, activeCards, localDropRates, rarityStats]);

  // Calculate actual probability for a given drop rate
  // 指定された出現重みから実際の確率を計算
  const calculateProbability = useCallback((dropRate: number): number => {
    if (totalWeight === 0) return 0;
    return (dropRate / totalWeight) * 100;
  }, [totalWeight]);

  // Check if any changes have been made
  // 変更があるかどうかをチェック
  // Check both localDropRates changes and rarity multiplier changes
  // localDropRatesの変更とレアリティ倍率の変更の両方をチェック
  const hasChanges = useMemo(() => {
    // Check if any card's localDropRate differs from original
    // カードのlocalDropRateが元の値と異なるかチェック
    for (const card of activeCards) {
      const localRate = localDropRates.get(card.id);
      if (localRate !== undefined && Math.abs(localRate - card.drop_rate) > 0.001) {
        return true;
      }
    }

    // Also check rarity multipliers (for rarity mode without reset)
    // レアリティ倍率もチェック（リセットなしのレアリティモード用）
    for (const [, multiplier] of rarityMultipliers) {
      if (Math.abs(multiplier - 1.0) > 0.001) {
        return true;
      }
    }

    return false;
  }, [activeCards, localDropRates, rarityMultipliers]);

  // Get modified card IDs for visual highlighting (individual mode)
  // 視覚的ハイライト用に変更されたカードIDを取得（個別モード）
  const modifiedCardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of activeCards) {
      const localRate = localDropRates.get(card.id);
      if (localRate !== undefined && localRate !== card.drop_rate) {
        ids.add(card.id);
      }
    }
    return ids;
  }, [activeCards, localDropRates]);

  // Get modified rarities for visual highlighting (rarity mode)
  // 視覚的ハイライト用に変更されたレアリティを取得（レアリティモード）
  const modifiedRarities = useMemo(() => {
    const rarities = new Set<Rarity>();
    for (const [rarity, multiplier] of rarityMultipliers) {
      if (Math.abs(multiplier - 1.0) > 0.001) {
        rarities.add(rarity);
      }
    }
    return rarities;
  }, [rarityMultipliers]);

  // Handle drop rate change (individual mode)
  // 出現確率変更を処理（個別モード）
  const handleDropRateChange = (cardId: string, value: number) => {
    setLocalDropRates(prev => {
      const next = new Map(prev);
      next.set(cardId, value);
      return next;
    });
  };

  // Handle rarity multiplier change (rarity mode)
  // レアリティ倍率変更を処理（レアリティモード）
  const handleRarityMultiplierChange = (rarity: Rarity, multiplier: number) => {
    setRarityMultipliers(prev => {
      const next = new Map(prev);
      next.set(rarity, multiplier);
      return next;
    });
  };

  /**
   * Reset all cards to weight 100% (1.0)
   * 全カードの重みを100%（1.0）にリセット
   * This works in both individual and rarity modes by directly setting localDropRates
   */
  const handleResetAll = () => {
    // Set all cards to weight 1.0 (100%)
    // 全カードの重みを1.0（100%）に設定
    setLocalDropRates(prev => {
      const next = new Map(prev);
      activeCards.forEach(card => {
        next.set(card.id, 1.0);
      });
      return next;
    });

    // Also reset all rarity multipliers to 1.0 for rarity mode
    // レアリティモード用に全レアリティの倍率も1.0にリセット
    setRarityMultipliers(prev => {
      const next = new Map(prev);
      RARITIES.forEach(r => {
        next.set(r.value, 1.0);
      });
      return next;
    });
  };

  /**
   * Reset all cards of a specific rarity to weight 100% (1.0)
   * 特定レアリティの全カードの重みを100%（1.0）にリセット
   */
  const handleResetRarity = (rarity: Rarity) => {
    // Set all cards of this rarity to weight 1.0 (100%)
    // このレアリティの全カードの重みを1.0（100%）に設定
    setLocalDropRates(prev => {
      const next = new Map(prev);
      activeCards
        .filter(card => card.rarity === rarity)
        .forEach(card => {
          next.set(card.id, 1.0);
        });
      return next;
    });

    // Also reset the multiplier for this rarity
    // このレアリティの倍率も1.0にリセット
    setRarityMultipliers(prev => {
      const next = new Map(prev);
      next.set(rarity, 1.0);
      return next;
    });
  };

  // Handle close with unsaved changes confirmation
  // 未保存の変更がある場合は確認ダイアログを表示してクローズ
  const handleClose = () => {
    if (hasChanges) {
      if (!confirm(t("batchDropRate.confirmClose"))) {
        return;
      }
    }
    onClose();
  };

  // Handle save
  // 保存処理
  const handleSave = async () => {
    if (!hasChanges) {
      return;
    }

    setSaving(true);
    try {
      // Get CSRF token from cookie
      // CookieからCSRFトークンを取得
      const csrfToken = document.cookie
        .split("; ")
        .find(row => row.startsWith("csrf_token="))
        ?.split("=")[1];

      const updates: Array<{ id: string; dropRate: number }> = [];
      // Track cards already added to avoid duplicates
      // 重複を避けるため追加済みカードを追跡
      const addedCardIds = new Set<string>();

      // First, add all cards with direct localDropRates changes (from reset or individual mode)
      // まず、localDropRatesが直接変更されたカードを追加（リセットまたは個別モードから）
      for (const card of activeCards) {
        const localRate = localDropRates.get(card.id);
        if (localRate !== undefined && Math.abs(localRate - card.drop_rate) > 0.001) {
          updates.push({
            id: card.id,
            dropRate: localRate,
          });
          addedCardIds.add(card.id);
        }
      }

      // Then, add cards from rarity multiplier changes (if in rarity mode and not already added)
      // 次に、レアリティ倍率変更からのカードを追加（レアリティモードで未追加のもの）
      if (activeTab === "rarity") {
        for (const [rarity, multiplier] of rarityMultipliers) {
          if (Math.abs(multiplier - 1.0) > 0.001) {
            const rarityCards = activeCards.filter(c => c.rarity === rarity);
            for (const card of rarityCards) {
              // Skip if already added via localDropRates
              // localDropRatesで既に追加済みの場合はスキップ
              if (addedCardIds.has(card.id)) continue;

              // Apply multiplier to original drop rate, clamped to 0-1 range
              // 元のドロップレートに倍率を適用、0-1範囲に制限
              const newRate = Math.min(1, Math.max(0, card.drop_rate * multiplier));
              updates.push({
                id: card.id,
                dropRate: newRate,
              });
              addedCardIds.add(card.id);
            }
          }
        }
      }

      if (updates.length === 0) {
        onClose();
        return;
      }

      const response = await fetch("/api/cards/batch-update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken || "",
        },
        credentials: "include",
        body: JSON.stringify({
          streamerId,
          updates,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || t("batchDropRate.saveFailed"));
      }

      const result = await response.json();

      // Call onSave with updated cards
      // 更新されたカードでonSaveを呼び出す
      if (result.cards) {
        onSave(result.cards);
      }

      onClose();
    } catch (error) {
      logger.error("Failed to batch update drop rates:", error);
      alert(error instanceof Error ? error.message : t("batchDropRate.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  // Get rarity info for a card
  // カードのレアリティ情報を取得
  const getRarityInfo = (rarity: Rarity) =>
    RARITIES.find((r) => r.value === rarity) || RARITIES[0];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={handleClose}>
      <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        {/* モーダルヘッダー */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">{t("batchDropRate.title")}</h3>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-white"
              aria-label="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Tab buttons */}
          {/* タブボタン */}
          <div className="mt-4 flex border-b border-gray-700">
            <button
              onClick={() => setActiveTab("rarity")}
              className={`px-4 py-2 text-sm font-medium transition ${
                activeTab === "rarity"
                  ? "text-purple-400 border-b-2 border-purple-400"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t("batchDropRate.tabRarity")}
            </button>
            <button
              onClick={() => setActiveTab("individual")}
              className={`px-4 py-2 text-sm font-medium transition ${
                activeTab === "individual"
                  ? "text-purple-400 border-b-2 border-purple-400"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t("batchDropRate.tabIndividual")}
            </button>
          </div>

          {/* Summary bar */}
          {/* サマリーバー */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-gray-400">{t("batchDropRate.totalWeight")}:</span>
                <span className="text-white font-medium">{(totalWeight * 100).toFixed(1)}%</span>
              </div>
              <div className="h-4 w-px bg-gray-600" />
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
            {/* Reset all button - resets all card weights to 100% */}
            {/* 全てリセットボタン - 全カードの重みを100%にリセット */}
            <button
              type="button"
              onClick={handleResetAll}
              className="rounded-lg border border-orange-500 px-3 py-1 text-sm text-orange-400 hover:bg-orange-500 hover:text-white transition"
            >
              {t("batchDropRate.resetAll")}
            </button>
          </div>
        </div>

        {/* Modal Body - Scrollable content */}
        {/* モーダル本文 - スクロール可能なコンテンツ */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeCards.length === 0 ? (
            <p className="text-center text-gray-400">{t("batchDropRate.noActiveCards")}</p>
          ) : activeTab === "individual" ? (
            /* Individual card adjustment tab */
            /* 個別カード調整タブ */
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
                    {/* Card info section */}
                    {/* カード情報セクション */}
                    <div className="flex items-center gap-3 min-w-0 sm:w-48 shrink-0">
                      {/* Card image thumbnail */}
                      {/* カード画像サムネイル */}
                      <div className="w-10 h-10 rounded bg-gray-600 overflow-hidden shrink-0">
                        {card.image_url ? (
                          <Image
                            src={card.image_url}
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

                      {/* Card name and rarity */}
                      {/* カード名とレアリティ */}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white truncate">{card.name}</p>
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs text-white ${rarityInfo.color}`}>
                          {tRarity(card.rarity)}
                        </span>
                      </div>
                    </div>

                    {/* Drop rate controls */}
                    {/* 出現確率コントロール */}
                    <div className="flex-1 flex flex-col sm:flex-row items-start sm:items-center gap-3">
                      {/* Slider */}
                      {/* スライダー */}
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

                      {/* Weight display and probability display */}
                      {/* 重み表示と確率表示 */}
                      <div className="flex items-center gap-3 shrink-0">
                        {/* Weight display (read-only) */}
                        {/* 重み表示（読み取り専用） */}
                        <div className="flex items-center gap-1 w-20">
                          <span className="text-xs text-gray-400">{t("batchDropRate.weight")}:</span>
                          <span className={`text-sm font-medium ${isModified ? "text-yellow-400" : "text-white"}`}>
                            {(currentRate * 100).toFixed(1)}%
                          </span>
                        </div>

                        {/* Probability display */}
                        {/* 確率表示 */}
                        <div className="flex items-center gap-1 w-20">
                          <span className="text-xs text-gray-400">→</span>
                          <span className={`text-sm font-medium ${isModified ? "text-yellow-400" : "text-green-400"}`}>
                            {probability.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* Rarity-based adjustment tab */
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
                    {/* Rarity header */}
                    {/* レアリティヘッダー */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <span className={`rounded-full px-3 py-1 text-sm font-medium text-white ${rarityConfig.color}`}>
                          {tRarity(rarity)}
                        </span>
                        <span className="text-sm text-gray-400">
                          {stats.cards.length} {t("batchDropRate.cardsCount")}
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        {/* Original weight display */}
                        {/* 元の重み表示 */}
                        <div className="text-sm text-gray-400">
                          {t("batchDropRate.originalWeight")}: {(stats.originalWeight * 100).toFixed(1)}%
                        </div>
                        {/* Reset rarity button - resets all cards of this rarity to weight 100% */}
                        {/* レアリティリセットボタン - このレアリティの全カードの重みを100%にリセット */}
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

                    {/* Multiplier slider */}
                    {/* 倍率スライダー */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm text-gray-400">{t("batchDropRate.multiplier")}:</span>
                        <span className={`text-sm font-medium w-12 text-right ${isModified ? "text-yellow-400" : "text-white"}`}>
                          x{multiplier.toFixed(2)}
                        </span>
                      </div>

                      {/* Slider */}
                      {/* スライダー */}
                      <div className="flex-1 w-full">
                        <input
                          type="range"
                          min="0"
                          max="3"
                          step="0.05"
                          value={multiplier}
                          onChange={(e) => handleRarityMultiplierChange(rarity, parseFloat(e.target.value))}
                          className="w-full"
                        />
                      </div>

                      {/* Result display */}
                      {/* 結果表示 */}
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-sm">
                          <span className="text-gray-400">{t("batchDropRate.newWeight")}: </span>
                          <span className={`font-medium ${isModified ? "text-yellow-400" : "text-white"}`}>
                            {(stats.currentWeight * 100).toFixed(1)}%
                          </span>
                        </div>
                        <span className="text-gray-500">→</span>
                        <div className="text-sm">
                          <span className={`font-medium ${isModified ? "text-yellow-400" : "text-green-400"}`}>
                            {rarityProbability.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        {/* モーダルフッター */}
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
