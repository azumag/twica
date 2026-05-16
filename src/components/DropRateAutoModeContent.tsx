"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import type { Card, Rarity } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import { formatRarityLabel } from "@/lib/rarity";
import { logger } from "@/lib/logger";
import { getOptimizedImageUrl } from "@/lib/image-utils";

interface DropRateAutoModeContentProps {
  cards: Card[];
  streamerId: string;
  rarityWeights: Record<string, number>;
  // カスタムレアリティ名（カード未使用でも重み設定欄に表示するため）
  customRarities: string[];
  onCardsSave: (updatedCards: Card[]) => void;
  onRarityWeightsApply: (
    w: Record<string, number> | null,
    c: Card[] | null
  ) => void;
  onSwitchToManualMode: () => void;
  onClose: () => void;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * DropRateAutoModeContent - 自動モード用の排出確率設定コンテンツ
 *
 * タブ1（レアリティ別設定）: レアリティごとの%スライダー+数値入力
 * タブ2（カードごとの調整）: intra_rarity_weightスライダー + 確率プレビュー
 */
export default function DropRateAutoModeContent({
  cards,
  streamerId,
  rarityWeights,
  customRarities,
  onCardsSave,
  onRarityWeightsApply,
  onSwitchToManualMode,
  onClose,
}: DropRateAutoModeContentProps) {
  const t = useTranslations("cardManager");
  const tRarity = useTranslations("rarity");
  const tCommon = useTranslations("common");
  const tRarityProb = useTranslations("rarityProbability");

  const [activeTab, setActiveTab] = useState<"rarity" | "perCard">("rarity");
  const [showHelp, setShowHelp] = useState(false);

  // === タブ1: レアリティ別設定 state ===
  const [draftWeights, setDraftWeights] = useState<Record<string, number>>(
    () => {
      const initial: Record<string, number> = {};
      for (const [key, value] of Object.entries(rarityWeights)) {
        initial[key] = clampPercent(value);
      }
      return initial;
    }
  );
  const [raritySaving, setRaritySaving] = useState(false);
  const [rarityMessage, setRarityMessage] = useState<string | null>(null);
  const [rarityError, setRarityError] = useState<string | null>(null);

  // === タブ2: カードごとの調整 state ===
  const [localIntraWeights, setLocalIntraWeights] = useState<
    Map<string, number>
  >(new Map());
  const [perCardSaving, setPerCardSaving] = useState(false);

  const activeCards = useMemo(
    () => cards.filter((card) => card.is_active),
    [cards]
  );

  // レアリティキー一覧の計算
  const rarityKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const rarity of RARITIES) keys.add(rarity.value);
    for (const card of cards) keys.add(card.rarity);
    for (const key of Object.keys(rarityWeights)) keys.add(key);
    for (const key of customRarities) keys.add(key);

    const baseOrder = RARITIES.map((rarity) => rarity.value) as string[];
    const extras = Array.from(keys)
      .filter((key) => !baseOrder.includes(key))
      .sort();
    return [...baseOrder.filter((key) => keys.has(key)), ...extras];
  }, [cards, rarityWeights, customRarities]);

  // アクティブカード数（レアリティ別）
  const activeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      if (!card.is_active) continue;
      counts.set(card.rarity, (counts.get(card.rarity) || 0) + 1);
    }
    return counts;
  }, [cards]);

  // rarityWeightsプロップの変化時のみdraftをリセット
  const prevRarityWeightsRef = useRef(rarityWeights);
  useEffect(() => {
    if (prevRarityWeightsRef.current === rarityWeights) return;
    prevRarityWeightsRef.current = rarityWeights;

    const nextDraft: Record<string, number> = {};
    for (const key of rarityKeys) {
      nextDraft[key] = clampPercent(rarityWeights[key] ?? 0);
    }
    setDraftWeights(nextDraft);
  }, [rarityWeights, rarityKeys]);

  // カスタムレアリティ追加時の未登録キー初期化。
  // rarityKeys にカード由来の新規レアリティが現れたとき、draftWeights に
  // 当該キーを 0 で先行登録する。これをしないと、新キーが入力欄に 0 表示
  // される一方で合計には反映されず、「合計100%」制約と実表示が乖離して
  // 保存できなくなる（カスタムレアリティ追加でUI制約が破綻する）ため。
  useEffect(() => {
    setDraftWeights((prev) => {
      const missingKeys = rarityKeys.filter(
        (key) => !Object.prototype.hasOwnProperty.call(prev, key)
      );
      if (missingKeys.length === 0) return prev;

      const next = { ...prev };
      for (const key of missingKeys) {
        next[key] = clampPercent(rarityWeights[key] ?? 0);
      }
      return next;
    });
  }, [rarityKeys, rarityWeights]);

  // レアリティ別合計
  const rarityTotal = useMemo(() => {
    return Object.values(draftWeights).reduce((sum, value) => sum + value, 0);
  }, [draftWeights]);
  const isRarityTotalValid = Math.abs(rarityTotal - 100) <= 0.001;

  // カードごと: intra weight初期化
  useEffect(() => {
    const initial = new Map<string, number>();
    activeCards.forEach((card) => {
      initial.set(card.id, card.intra_rarity_weight ?? 1.0);
    });
    setLocalIntraWeights(initial);
  }, [activeCards]);

  // カードごと: 変更チェック
  const perCardHasChanges = useMemo(() => {
    for (const card of activeCards) {
      const localWeight = localIntraWeights.get(card.id);
      const originalWeight = card.intra_rarity_weight ?? 1.0;
      if (
        localWeight !== undefined &&
        Math.abs(localWeight - originalWeight) > 0.001
      ) {
        return true;
      }
    }
    return false;
  }, [activeCards, localIntraWeights]);

  // カードごと: 変更カードID
  const modifiedCardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const card of activeCards) {
      const localWeight = localIntraWeights.get(card.id);
      const originalWeight = card.intra_rarity_weight ?? 1.0;
      if (
        localWeight !== undefined &&
        Math.abs(localWeight - originalWeight) > 0.001
      ) {
        ids.add(card.id);
      }
    }
    return ids;
  }, [activeCards, localIntraWeights]);

  // カードごと: レアリティ内合計
  const rarityIntraTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const card of activeCards) {
      const weight =
        localIntraWeights.get(card.id) ?? (card.intra_rarity_weight ?? 1.0);
      const current = totals.get(card.rarity) ?? 0;
      totals.set(card.rarity, current + weight);
    }
    return totals;
  }, [activeCards, localIntraWeights]);

  // レアリティ別: draftWeightsの変更チェック
  const rarityHasChanges = useMemo(() => {
    for (const key of rarityKeys) {
      const draft = draftWeights[key] ?? 0;
      const original = rarityWeights[key] ?? 0;
      if (Math.abs(draft - original) > 0.001) return true;
    }
    return false;
  }, [draftWeights, rarityWeights, rarityKeys]);

  // 両タブの変更を常にチェック（タブ切替後のクローズでも確認ダイアログが出るように）
  const hasAnyChanges = rarityHasChanges || perCardHasChanges;

  const getRarityLabel = (rarity: string): string => formatRarityLabel(rarity, tRarity);

  const getRarityInfo = (rarity: Rarity) =>
    RARITIES.find((r) => r.value === rarity) || RARITIES[0];

  // === レアリティ別: 保存 ===
  // レアリティ保存後、サーバーがカードのdrop_rateを再計算するため
  // カードごとタブの未保存weight変更は意味を失う → 確認してからリセット
  const saveRarityWeights = async () => {
    if (perCardHasChanges && !confirm(t("batchDropRate.confirmClose"))) return;
    if (!isRarityTotalValid) {
      setRarityMessage(null);
      setRarityError(tRarityProb("totalWarning"));
      return;
    }
    setRaritySaving(true);
    setRarityMessage(null);
    setRarityError(null);

    try {
      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          streamerId,
          rarityWeights: draftWeights,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setRarityError(data.error || tRarityProb("totalWarning"));
        return;
      }

      const recalculatedCards = Array.isArray(data.recalculatedCards)
        ? (data.recalculatedCards as Card[])
        : null;
      onRarityWeightsApply(draftWeights, recalculatedCards);
      setRarityMessage(tRarityProb("saved"));
    } catch (saveError) {
      logger.error("Failed to save rarity weights:", saveError);
      setRarityError(tRarityProb("totalWarning"));
    } finally {
      setRaritySaving(false);
    }
  };

  // === カードごと: 全リセット ===
  const handleResetAll = () => {
    setLocalIntraWeights((prev) => {
      const next = new Map(prev);
      activeCards.forEach((card) => {
        next.set(card.id, 1.0);
      });
      return next;
    });
  };

  // === カードごと: 保存 ===
  // カードごと保存時にレアリティタブの未保存変更があれば確認
  // （保存完了後にモーダルが閉じるため、ドラフトが消失する）
  const handlePerCardSave = async () => {
    if (!perCardHasChanges) return;
    if (rarityHasChanges && !confirm(t("batchDropRate.confirmClose"))) return;
    setPerCardSaving(true);
    try {
      const updates: Array<{
        id: string;
        dropRate: number;
        intraRarityWeight: number;
      }> = [];
      for (const card of activeCards) {
        const localWeight = localIntraWeights.get(card.id);
        const originalWeight = card.intra_rarity_weight ?? 1.0;
        if (
          localWeight !== undefined &&
          Math.abs(localWeight - originalWeight) > 0.001
        ) {
          updates.push({
            id: card.id,
            dropRate: card.drop_rate,
            intraRarityWeight: localWeight,
          });
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
        },
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
            (result.recalculatedCards as Card[]).map((c) => [c.id, c])
          );
          allUpdatedCards = allUpdatedCards.map(
            (c) => recalculatedMap.get(c.id) || c
          );
          for (const rc of result.recalculatedCards as Card[]) {
            if (!allUpdatedCards.some((c) => c.id === rc.id)) {
              allUpdatedCards.push(rc);
            }
          }
        }
        onCardsSave(allUpdatedCards);
      }
      onClose();
    } catch (error) {
      logger.error("Failed to batch update drop rates:", error);
      alert(
        error instanceof Error ? error.message : t("batchDropRate.saveFailed")
      );
    } finally {
      setPerCardSaving(false);
    }
  };

  // 未保存変更がある場合は確認ダイアログ
  const handleClose = () => {
    if (hasAnyChanges && !confirm(t("batchDropRate.confirmClose"))) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={handleClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl bg-gray-800 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-white">
                {t("dropRateSettings.title")}
              </h3>
              <button
                type="button"
                onClick={() => setShowHelp(true)}
                className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-gray-500 text-gray-400 hover:text-gray-200 hover:border-gray-300 text-xs leading-none transition-colors shrink-0"
                aria-label={tRarityProb("help.title")}
              >
                ?
              </button>
            </div>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-white"
              aria-label="Close"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* タブ */}
          <div className="mt-4 flex border-b border-gray-700">
            <button
              onClick={() => setActiveTab("rarity")}
              className={`px-4 py-2 text-sm font-medium transition ${
                activeTab === "rarity"
                  ? "text-purple-400 border-b-2 border-purple-400"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t("dropRateSettings.tabRarity")}
            </button>
            <button
              onClick={() => setActiveTab("perCard")}
              className={`px-4 py-2 text-sm font-medium transition ${
                activeTab === "perCard"
                  ? "text-purple-400 border-b-2 border-purple-400"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {t("dropRateSettings.tabPerCard")}
            </button>
          </div>

          {/* サマリーバー（カードごとタブ時のみ） */}
          {activeTab === "perCard" && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-4 text-sm">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-gray-400">
                    {t("batchDropRate.activeCards")}:
                  </span>
                  <span className="text-white font-medium">
                    {activeCards.length}
                  </span>
                </div>
                {perCardHasChanges && (
                  <>
                    <div className="h-4 w-px bg-gray-600" />
                    <div className="flex items-center gap-2">
                      <span className="text-yellow-400">
                        {modifiedCardIds.size}{" "}
                        {t("batchDropRate.cardsModified")}
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
          )}
        </div>

        {/* 本文 */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "rarity" ? (
            /* === タブ1: レアリティ別設定 === */
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-gray-300">
                  {tRarityProb("total")}:{" "}
                  <span className="font-medium text-white">
                    {rarityTotal.toFixed(1)}%
                  </span>
                </span>
                {!isRarityTotalValid && (
                  <span className="rounded bg-yellow-500/20 px-2 py-1 text-xs text-yellow-300">
                    {tRarityProb("totalWarning")}
                  </span>
                )}
              </div>

              <div className="space-y-3">
                {rarityKeys.map((rarity) => {
                  const count = activeCounts.get(rarity) || 0;
                  const value = draftWeights[rarity] ?? 0;

                  return (
                    <div key={rarity} className="rounded-lg bg-gray-700 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-white">
                          {getRarityLabel(rarity)}
                        </span>
                        <span className="text-xs text-gray-400">
                          {count > 0
                            ? `${count}${tRarityProb("activeCards")}`
                            : tRarityProb("noCards")}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={0.1}
                          value={value}
                          onChange={(event) => {
                            const nextValue = clampPercent(
                              Number(event.target.value)
                            );
                            setDraftWeights((prev) => ({
                              ...prev,
                              [rarity]: nextValue,
                            }));
                          }}
                          className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-gray-600 accent-purple-500"
                        />
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={value}
                          onChange={(event) => {
                            const nextValue = clampPercent(
                              Number(event.target.value)
                            );
                            setDraftWeights((prev) => ({
                              ...prev,
                              [rarity]: nextValue,
                            }));
                          }}
                          className="w-20 rounded bg-gray-600 px-2 py-1 text-right text-sm text-white"
                        />
                        <span className="w-6 text-sm text-gray-400">%</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {rarityMessage && (
                <p className="text-sm text-green-400">{rarityMessage}</p>
              )}
              {rarityError && (
                <p className="text-sm text-red-400">{rarityError}</p>
              )}
            </div>
          ) : (
            /* === タブ2: カードごとの調整 === */
            <div>
              {activeCards.length === 0 ? (
                <p className="text-center text-gray-400">
                  {t("batchDropRate.noActiveCards")}
                </p>
              ) : (
                <div className="space-y-3">
                  {activeCards.map((card) => {
                    const rarityInfo = getRarityInfo(card.rarity);
                    const currentWeight =
                      localIntraWeights.get(card.id) ??
                      (card.intra_rarity_weight ?? 1.0);
                    const isModified = modifiedCardIds.has(card.id);

                    // 確率プレビュー: draftWeightsを使用してレアリティ編集を即反映
                    // card_rate = (rarity_pct / 100) * (intra_weight / total_intra)
                    const targetPercent = draftWeights[card.rarity] ?? 0;
                    const sameRarityTotal =
                      rarityIntraTotals.get(card.rarity) ?? 0;
                    const overallPercent =
                      sameRarityTotal > 0
                        ? (targetPercent / 100) *
                          (currentWeight / sameRarityTotal) *
                          100
                        : 0;

                    return (
                      <div
                        key={card.id}
                        className={`flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg p-3 transition ${
                          isModified
                            ? "bg-yellow-900/30 border border-yellow-600/50"
                            : "bg-gray-700"
                        }`}
                      >
                        {/* カード情報 */}
                        <div className="flex items-center gap-3 min-w-0 sm:w-48 shrink-0">
                          <div className="w-10 h-10 rounded bg-gray-600 overflow-hidden shrink-0">
                            {card.image_url ? (
                              <Image
                                src={getOptimizedImageUrl(
                                  card.image_url,
                                  "icon"
                                )}
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
                            <p className="text-sm font-medium text-white truncate">
                              {card.name}
                            </p>
                            <span
                              className={`inline-block rounded-full px-2 py-0.5 text-xs text-white ${rarityInfo.color}`}
                            >
                              {getRarityLabel(card.rarity)}
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
                                setLocalIntraWeights((prev) => {
                                  const next = new Map(prev);
                                  next.set(card.id, val);
                                  return next;
                                });
                              }}
                              className="w-full"
                            />
                          </div>
                          {targetPercent > 0 && (
                            <div className="flex items-center gap-2 text-sm shrink-0">
                              <span className="text-xs text-gray-500">
                                {t("batchDropRate.overallDropRate")}
                              </span>
                              <span
                                className={`font-medium ${isModified ? "text-yellow-400" : "text-green-400"}`}
                              >
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
          )}
        </div>

        {/* フッター */}
        <div className="p-6 border-t border-gray-700 bg-gray-800/50">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                // 未保存変更がある場合は確認（モード切替で変更が失われるため）
                if (hasAnyChanges && !confirm(t("batchDropRate.confirmClose"))) return;
                onSwitchToManualMode();
              }}
              className="text-sm text-gray-400 hover:text-white transition text-left"
            >
              {t("dropRateSettings.switchToManual")}
            </button>
            <div className="flex justify-end gap-3">
              <button
                onClick={handleClose}
                className="rounded-lg border border-gray-600 px-4 py-2 text-gray-300 hover:bg-gray-700"
              >
                {tCommon("cancel")}
              </button>
              {activeTab === "rarity" ? (
                <button
                  onClick={saveRarityWeights}
                  disabled={!rarityHasChanges || raritySaving || !isRarityTotalValid}
                  className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {raritySaving
                    ? tRarityProb("saving")
                    : tRarityProb("save")}
                </button>
              ) : (
                <button
                  onClick={handlePerCardSave}
                  disabled={!perCardHasChanges || perCardSaving}
                  className="rounded-lg bg-purple-600 px-4 py-2 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {perCardSaving
                    ? t("batchDropRate.saving")
                    : t("batchDropRate.save")}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ヘルプモーダル（親モーダルより上に表示するため z-[60]） */}
      {showHelp && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-gray-800 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">
                {tRarityProb("help.title")}
              </h3>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="text-gray-400 hover:text-white"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="space-y-5 text-sm text-gray-300">
              <div>
                <h4 className="mb-2 font-semibold text-purple-400">
                  {tRarityProb("help.autoModeTitle")}
                </h4>
                <ul className="space-y-1.5 list-disc pl-4">
                  <li>{tRarityProb("help.autoModeDesc1")}</li>
                  <li>{tRarityProb("help.autoModeDesc2")}</li>
                  <li>{tRarityProb("help.autoModeDesc3")}</li>
                </ul>
              </div>

              <div className="rounded-lg bg-gray-700/50 p-3">
                <p className="mb-2 font-medium text-gray-200">
                  {tRarityProb("help.exampleTitle")}
                </p>
                <p className="mb-2 text-xs text-gray-400">
                  {tRarityProb("help.exampleDesc")}
                </p>
                <div className="space-y-0.5 font-mono text-xs text-gray-300">
                  <p>{tRarityProb("help.exampleA")}</p>
                  <p>{tRarityProb("help.exampleB")}</p>
                  <p>{tRarityProb("help.exampleC")}</p>
                </div>
              </div>

              <div>
                <h4 className="mb-2 font-semibold text-gray-200">
                  {tRarityProb("help.perCardModeTitle")}
                </h4>
                <p>{tRarityProb("help.perCardModeDesc")}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
