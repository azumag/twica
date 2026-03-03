"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { Card } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import { logger } from "@/lib/logger";

interface RarityProbabilityPanelProps {
  streamerId: string;
  cards: Card[];
  rarityWeights: Record<string, number> | null;
  onApply: (rarityWeights: Record<string, number> | null, recalculatedCards: Card[] | null) => void;
}

const DEFAULT_RARITY_WEIGHTS: Record<string, number> = {
  common: 50,
  rare: 30,
  epic: 15,
  legendary: 5,
};

function getCsrfTokenFromCookie(): string {
  if (typeof document === "undefined") return "";
  return (
    document.cookie
      .split("; ")
      .find((row) => row.startsWith("csrf_token="))
      ?.split("=")[1] || ""
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export default function RarityProbabilityPanel({
  streamerId,
  cards,
  rarityWeights,
  onApply,
}: RarityProbabilityPanelProps) {
  const t = useTranslations("rarityProbability");
  const tRarity = useTranslations("rarity");
  const [expanded, setExpanded] = useState(rarityWeights !== null);
  // rarityWeightsが設定済みならマウント時にdraftへ反映（初期表示でスライダーが0%になるのを防止）
  const [draftWeights, setDraftWeights] = useState<Record<string, number>>(() => {
    if (!rarityWeights) return {};
    const initial: Record<string, number> = {};
    for (const [key, value] of Object.entries(rarityWeights)) {
      initial[key] = clampPercent(value);
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const rarityKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const rarity of RARITIES) keys.add(rarity.value);
    for (const card of cards) keys.add(card.rarity);
    if (rarityWeights) {
      for (const key of Object.keys(rarityWeights)) {
        keys.add(key);
      }
    }

    const baseOrder = RARITIES.map((rarity) => rarity.value) as string[];
    const extras = Array.from(keys).filter((key) => !baseOrder.includes(key)).sort();
    return [...baseOrder.filter((key) => keys.has(key)), ...extras];
  }, [cards, rarityWeights]);

  const activeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of cards) {
      if (!card.is_active) continue;
      counts.set(card.rarity, (counts.get(card.rarity) || 0) + 1);
    }
    return counts;
  }, [cards]);

  // rarityWeightsプロップの変化時のみdraftをリセットする
  // rarityKeys（カード操作で変化）に依存すると編集中のdraftが失われるため除外
  const prevRarityWeightsRef = useRef(rarityWeights);
  useEffect(() => {
    // rarityWeightsプロップが実際に変化した場合のみリセット
    if (prevRarityWeightsRef.current === rarityWeights) return;
    prevRarityWeightsRef.current = rarityWeights;

    if (rarityWeights === null) {
      setDraftWeights({});
      return;
    }

    const nextDraft: Record<string, number> = {};
    for (const key of rarityKeys) {
      nextDraft[key] = clampPercent(rarityWeights[key] ?? 0);
    }
    setDraftWeights(nextDraft);
  }, [rarityWeights, rarityKeys]);

  const total = useMemo(() => {
    return Object.values(draftWeights).reduce((sum, value) => sum + value, 0);
  }, [draftWeights]);

  const getRarityLabel = (rarity: string): string => {
    try {
      return tRarity(rarity as "common");
    } catch {
      return rarity;
    }
  };

  const initializeDefaults = () => {
    const defaults: Record<string, number> = {};
    for (const key of rarityKeys) {
      defaults[key] = DEFAULT_RARITY_WEIGHTS[key] ?? 0;
    }
    setDraftWeights(defaults);
    setExpanded(true);
    setMessage(null);
    setError(null);
  };

  const saveRarityWeights = async (nextWeights: Record<string, number> | null) => {
    setSaving(true);
    setMessage(null);
    setError(null);

    try {
      // 手動モード切替時(null)は {} をセンチネルとしてDB保存
      // DB上の null は「未設定」を意味し、次回ロード時に自動モードがデフォルト有効化される
      const apiWeights = nextWeights === null ? {} : nextWeights;

      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfTokenFromCookie(),
        },
        credentials: "include",
        body: JSON.stringify({
          streamerId,
          rarityWeights: apiWeights,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || t("totalWarning"));
        return;
      }

      const recalculatedCards = Array.isArray(data.recalculatedCards)
        ? (data.recalculatedCards as Card[])
        : null;
      onApply(nextWeights, recalculatedCards);
      setMessage(t("saved"));
    } catch (saveError) {
      logger.error("Failed to save rarity weights:", saveError);
      setError(t("totalWarning"));
    } finally {
      setSaving(false);
    }
  };

  const isAutoMode = rarityWeights !== null;
  const isEditing = isAutoMode || Object.keys(draftWeights).length > 0;

  return (
    <div className="mb-6 overflow-hidden rounded-lg border border-gray-700 bg-gray-900/50">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <div>
            <p className="font-medium text-white">{t("title")}</p>
            <p className="text-xs text-gray-400">{t("description")}</p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowHelp(true);
            }}
            className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-gray-500 text-gray-400 hover:text-gray-200 hover:border-gray-300 text-xs leading-none transition-colors shrink-0"
            aria-label={t("help.title")}
          >
            ?
          </button>
        </div>
        <span className="text-gray-400">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="border-t border-gray-700 p-4">
          {!isEditing ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={initializeDefaults}
                className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700"
              >
                {t("enable")}
              </button>
              <p className="text-xs text-gray-400">50 / 30 / 15 / 5</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-gray-300">
                  {t("total")}: <span className="font-medium text-white">{total.toFixed(1)}%</span>
                </span>
                {Math.abs(total - 100) > 0.001 && (
                  <span className="rounded bg-yellow-500/20 px-2 py-1 text-xs text-yellow-300">
                    {t("totalWarning")}
                  </span>
                )}
              </div>

              <div className="space-y-3">
                {rarityKeys.map((rarity) => {
                  const count = activeCounts.get(rarity) || 0;
                  const value = draftWeights[rarity] ?? 0;

                  return (
                    <div key={rarity} className="rounded-lg bg-gray-800 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-white">{getRarityLabel(rarity)}</span>
                        <span className="text-xs text-gray-400">
                          {count > 0 ? `${count}${t("activeCards")}` : t("noCards")}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        {/* スライダー（メイン操作） */}
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={0.1}
                          value={value}
                          onChange={(event) => {
                            const nextValue = clampPercent(Number(event.target.value));
                            setDraftWeights((prev) => ({
                              ...prev,
                              [rarity]: nextValue,
                            }));
                          }}
                          className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-gray-600 accent-purple-500"
                        />
                        {/* 数値入力（微調整用） */}
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={value}
                          onChange={(event) => {
                            const nextValue = clampPercent(Number(event.target.value));
                            setDraftWeights((prev) => ({
                              ...prev,
                              [rarity]: nextValue,
                            }));
                          }}
                          className="w-20 rounded bg-gray-700 px-2 py-1 text-right text-sm text-white"
                        />
                        <span className="w-6 text-sm text-gray-400">%</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => saveRarityWeights(draftWeights)}
                  className="rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {saving ? t("saving") : t("save")}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    if (isAutoMode) {
                      saveRarityWeights(null);
                    } else {
                      setDraftWeights({});
                    }
                  }}
                  className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50"
                >
                  {t("disable")}
                </button>
              </div>
            </div>
          )}

          {message && <p className="mt-3 text-sm text-green-400">{message}</p>}
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </div>
      )}

      {/* ヘルプモーダル */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setShowHelp(false)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-gray-800 p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">{t("help.title")}</h3>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="text-gray-400 hover:text-white"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-5 text-sm text-gray-300">
              {/* 自動モード説明 */}
              <div>
                <h4 className="mb-2 font-semibold text-purple-400">{t("help.autoModeTitle")}</h4>
                <ul className="space-y-1.5 list-disc pl-4">
                  <li>{t("help.autoModeDesc1")}</li>
                  <li>{t("help.autoModeDesc2")}</li>
                  <li>{t("help.autoModeDesc3")}</li>
                </ul>
              </div>

              {/* 計算例 */}
              <div className="rounded-lg bg-gray-700/50 p-3">
                <p className="mb-2 font-medium text-gray-200">{t("help.exampleTitle")}</p>
                <p className="mb-2 text-xs text-gray-400">{t("help.exampleDesc")}</p>
                <div className="space-y-0.5 font-mono text-xs text-gray-300">
                  <p>{t("help.exampleA")}</p>
                  <p>{t("help.exampleB")}</p>
                  <p>{t("help.exampleC")}</p>
                </div>
              </div>

              {/* カードごとモード説明 */}
              <div>
                <h4 className="mb-2 font-semibold text-gray-200">{t("help.perCardModeTitle")}</h4>
                <p>{t("help.perCardModeDesc")}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
