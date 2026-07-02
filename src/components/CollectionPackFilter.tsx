"use client";

import { useState } from "react";
import type { ComponentProps } from "react";
import { useTranslations } from "next-intl";
import SortedCardGrid from "./SortedCardGrid";
import CollectionProgress from "./CollectionProgress";
import { cardMatchesPackKey } from "@/lib/collection-packs";
import type { StreamerCollectionCard } from "./StreamerCollection";

// SortedCardGrid の translations 契約をそのまま再利用する（Server→Client の
// シリアライズ済み文字列オブジェクト）。型を再宣言せず参照することで、
// SortedCardGrid 側にキーが増えたときに型エラーとして追従漏れを検出できる。
type GridTranslations = ComponentProps<typeof SortedCardGrid>["translations"];

/**
 * Per-pack display payload prepared server-side (Issue #557).
 * completionHistory はこのパックの達成レコードのみ（ページ側で
 * collection_name 一致に絞り込み済み。楽観的な「今達成した」レコードの
 * 合成も全体表示と同じ規則でページ側が済ませている）。
 */
export interface CollectionPackDisplay {
  // Filter key: collection_name, or DEFAULT_PACK_SENTINEL for the default pack.
  key: string;
  // Display label. null = the streamer hasn't overridden the default pack's
  // name (default_card_pack_name) → fall back to the generic i18n label.
  displayName: string | null;
  progress: { owned: number; total: number };
  completionHistory: { total_cards: number; completed_at: string }[];
}

interface CollectionPackFilterProps {
  // Full card list (owned first, then visible unowned) — identical to what
  // the unfiltered page renders.
  cards: StreamerCollectionCard[];
  streamerId: string;
  hideUnownedDetails: boolean;
  overallProgress: { owned: number; total: number };
  overallCompletionHistory: { total_cards: number; completed_at: string }[];
  packs: CollectionPackDisplay[];
  gridTranslations: GridTranslations;
}

/**
 * CollectionPackFilter - コレクションページのパック絞り込みUI (Issue #557)
 *
 * クライアント状態のみでタブ（チップ）を切り替える：
 * - 「すべて」（初期選択）: 従来どおり全カード + 全体進捗を表示
 * - 各パック: そのパックのカードのみ + パック内進捗（達成済みなら
 *   「コンプリート！」と達成日時。表示は CollectionProgress を再利用）
 *
 * ボタンの見た目は SortedCardGrid の既存ソート切替ボタンに合わせる。
 * 名前付きパックが1つも無い配信者ではこのコンポーネント自体が描画されない
 * （StreamerCollection 側で packs 空配列のとき従来表示に分岐）。
 */
export default function CollectionPackFilter({
  cards,
  streamerId,
  hideUnownedDetails,
  overallProgress,
  overallCompletionHistory,
  packs,
  gridTranslations,
}: CollectionPackFilterProps) {
  const t = useTranslations("streamerCollection");
  // null = 「すべて」。パックの key はサーバー側で導出済みの
  // collection_name / DEFAULT_PACK_SENTINEL をそのまま使う。
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const selectedPack =
    selectedKey === null
      ? null
      : (packs.find((pack) => pack.key === selectedKey) ?? null);

  // 「すべて」は無加工の全カード（従来表示と同一）、パック選択時は
  // cardMatchesPackKey（sentinel→未分類、それ以外は完全一致）で絞り込む。
  const visibleCards =
    selectedPack === null
      ? cards
      : cards.filter((card) =>
          cardMatchesPackKey(card.collection_name, selectedPack.key)
        );

  const progress = selectedPack?.progress ?? overallProgress;
  const completionHistory =
    selectedPack?.completionHistory ?? overallCompletionHistory;

  const packLabel = (pack: CollectionPackDisplay): string =>
    pack.displayName ?? t("packFilter.defaultName");

  // SortedCardGrid のソート切替と同じピル型ボタンスタイル（見た目の統一）。
  const buttonClass = (isSelected: boolean): string =>
    `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
      isSelected
        ? "bg-purple-600 text-white"
        : "border border-gray-600 text-gray-300 hover:bg-gray-700"
    }`;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-400">{t("packFilter.label")}</span>
        <button
          type="button"
          onClick={() => setSelectedKey(null)}
          className={buttonClass(selectedPack === null)}
          aria-pressed={selectedPack === null}
        >
          {t("packFilter.all")}
        </button>
        {packs.map((pack) => (
          <button
            key={pack.key}
            type="button"
            onClick={() => setSelectedKey(pack.key)}
            className={buttonClass(selectedPack?.key === pack.key)}
            aria-pressed={selectedPack?.key === pack.key}
          >
            {packLabel(pack)}
          </button>
        ))}
      </div>

      {/* 選択スコープ（全体 or パック）の進捗・コンプリート表示。
          全体表示時は従来の CollectionProgress と完全に同じ入力になる。 */}
      <CollectionProgress
        owned={progress.owned}
        total={progress.total}
        completionHistory={completionHistory}
      />

      {visibleCards.length === 0 ? (
        <div className="rounded-xl bg-gray-800 p-8 text-center">
          {selectedPack === null ? (
            // 「すべて」で空 = 所持0枚の視聴者（未所持カード非公開の配信者）。
            // packs 無し配信者の従来空表示 (StreamerCollection 側の分岐) と
            // 同じ i18n キーで CTA 付き2行を出し、文言・体験を一致させる。
            <p className="text-gray-400">
              {t("empty.line1")}
              <br />
              {t("empty.line2")}
            </p>
          ) : (
            // パック選択時のみパック文脈の空メッセージ（そのパックのカードを
            // 1枚も持っていないケース）。
            <p className="text-gray-400">{t("packFilter.emptyPack")}</p>
          )}
        </div>
      ) : (
        <SortedCardGrid
          cards={visibleCards}
          streamerId={streamerId}
          hideUnownedDetails={hideUnownedDetails}
          translations={gridTranslations}
        />
      )}
    </>
  );
}
