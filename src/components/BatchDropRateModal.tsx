"use client";

import type { Card } from "@/types/database";
import BatchDropRateAutoContent from "./BatchDropRateAutoContent";
import BatchDropRateManualContent from "./BatchDropRateManualContent";

interface BatchDropRateModalProps {
  isOpen: boolean;
  onClose: () => void;
  cards: Card[];
  streamerId: string;
  onSave: (updatedCards: Card[]) => void;
  warningMessage?: string;
  autoMode?: boolean;
  rarityWeights?: Record<string, number> | null;
}

/**
 * BatchDropRateModal - 確率一括調整モーダルのルーター
 *
 * autoMode に応じて Auto/Manual コンテンツを切り替える。
 * Props は CardManager.tsx から変更なし。
 */
export default function BatchDropRateModal({
  isOpen,
  onClose,
  cards,
  streamerId,
  onSave,
  warningMessage,
  autoMode = false,
  rarityWeights = null,
}: BatchDropRateModalProps) {
  if (!isOpen) return null;

  if (autoMode && rarityWeights) {
    return (
      <BatchDropRateAutoContent
        onClose={onClose}
        cards={cards}
        streamerId={streamerId}
        onSave={onSave}
        warningMessage={warningMessage}
        rarityWeights={rarityWeights}
      />
    );
  }

  return (
    <BatchDropRateManualContent
      onClose={onClose}
      cards={cards}
      streamerId={streamerId}
      onSave={onSave}
    />
  );
}
