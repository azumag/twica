"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Card } from "@/types/database";
import { DEFAULT_RARITY_WEIGHTS } from "@/lib/constants";
import { logger } from "@/lib/logger";
import DropRateAutoModeContent from "./DropRateAutoModeContent";
import BatchDropRateManualContent from "./BatchDropRateManualContent";

interface DropRateSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  cards: Card[];
  streamerId: string;
  onCardsSave: (updatedCards: Card[]) => void;
  onRarityWeightsApply: (
    w: Record<string, number> | null,
    c: Card[] | null
  ) => void;
  rarityWeights: Record<string, number> | null;
  // カスタムレアリティ名（自動モードで重みを割り当てられるよう一覧へ含める）
  customRarities: string[];
  // Issue #580(#576 フェーズ3): パック別レアリティ配分UI用のプロップ群。
  // 事前登録カードパック名(空配列ならスコープ切替UI自体を出さない)。
  cardPackNames: string[];
  // 「デフォルト」(未分類)パックの表示名オーバーライド
  defaultPackName: string | null;
  // レアリティ重みのスコープ('global'|'per_pack')
  rarityWeightsScope: "global" | "per_pack";
  // パック別レアリティ重みの上書きマップ（null = エントリなし）
  packRarityWeights: Record<string, Record<string, number>> | null;
  // 保存成功後、サーバーの永続値でスコープ/パック別重みを再同期するコールバック
  onPackWeightsApply: (
    scope: "global" | "per_pack",
    packRarityWeights: Record<string, Record<string, number>>
  ) => void;
}

/**
 * DropRateSettingsModal - 排出確率設定モーダルのルーター
 *
 * rarityWeights の有無で Auto/Manual コンテンツを切り替える。
 * モード切替APIもこのコンポーネントに集約し、
 * API失敗時はモード切替しない（UI/DB乖離防止）。
 */
export default function DropRateSettingsModal({
  isOpen,
  onClose,
  cards,
  streamerId,
  onCardsSave,
  onRarityWeightsApply,
  rarityWeights,
  customRarities,
  cardPackNames,
  defaultPackName,
  rarityWeightsScope,
  packRarityWeights,
  onPackWeightsApply,
}: DropRateSettingsModalProps) {
  const t = useTranslations("cardManager");
  const [switching, setSwitching] = useState(false);

  if (!isOpen) return null;

  // モード切替: POST /api/streamer/settings でDB更新後にコールバック
  const switchMode = async (toAuto: boolean) => {
    const message = toAuto
      ? t("dropRateSettings.confirmSwitchToAuto")
      : t("dropRateSettings.confirmSwitchToManual");
    if (!confirm(message)) return;

    setSwitching(true);
    try {
      // 自動→手動: {} をセンチネルとして保存（null = 未設定、{} = 手動モード明示）
      // 手動→自動: デフォルトのレアリティ比率を保存
      const apiWeights = toAuto ? DEFAULT_RARITY_WEIGHTS : {};

      const response = await fetch("/api/streamer/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ streamerId, rarityWeights: apiWeights }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("dropRateSettings.switchFailed"));
      }

      if (toAuto) {
        // 手動→自動: デフォルト比率 + 再計算結果を親に通知
        const recalculatedCards = Array.isArray(data.recalculatedCards)
          ? (data.recalculatedCards as Card[])
          : null;
        onRarityWeightsApply(DEFAULT_RARITY_WEIGHTS, recalculatedCards);
      } else {
        // 自動→手動: null で親に通知
        onRarityWeightsApply(null, null);
      }
      // モード切替後もモーダルは閉じない（新しいモードのコンテンツが即座に表示）
    } catch (error) {
      logger.error("Failed to switch mode:", error);
      alert(
        error instanceof Error
          ? error.message
          : t("dropRateSettings.switchFailed")
      );
    } finally {
      setSwitching(false);
    }
  };

  if (switching) {
    // 切替中はシンプルなローディング表示
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="rounded-xl bg-gray-800 p-8 shadow-2xl">
          <p className="text-white animate-pulse">{t("dropRateSettings.title")}...</p>
        </div>
      </div>
    );
  }

  // rarityWeights が設定済み → 自動モード（型絞り込みも効く）
  if (rarityWeights) {
    return (
      <DropRateAutoModeContent
        cards={cards}
        streamerId={streamerId}
        rarityWeights={rarityWeights}
        customRarities={customRarities}
        cardPackNames={cardPackNames}
        defaultPackName={defaultPackName}
        rarityWeightsScope={rarityWeightsScope}
        packRarityWeights={packRarityWeights}
        onPackWeightsApply={onPackWeightsApply}
        onCardsSave={onCardsSave}
        onRarityWeightsApply={onRarityWeightsApply}
        onSwitchToManualMode={() => switchMode(false)}
        onClose={onClose}
      />
    );
  }

  return (
    <BatchDropRateManualContent
      onClose={onClose}
      cards={cards}
      streamerId={streamerId}
      onSave={onCardsSave}
      onSwitchToAutoMode={() => switchMode(true)}
    />
  );
}
