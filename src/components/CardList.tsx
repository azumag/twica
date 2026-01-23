"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { Card, Rarity } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import ExpandableDescription from "./ExpandableDescription";

interface CardListProps {
  // Array of cards to display
  // 表示するカードの配列
  cards: Card[];
  // Total weight of all active cards (for calculating actual probability)
  // 全アクティブカードの重み合計（実際の出現確率計算用）
  totalActiveWeight?: number;
  // Callback when edit button is clicked
  // 編集ボタンクリック時のコールバック
  onEdit?: (card: Card) => void;
  // Callback when delete button is clicked
  // 削除ボタンクリック時のコールバック
  onDelete?: (cardId: string) => void;
  // Callback when toggle active button is clicked
  // 有効/無効切り替えボタンクリック時のコールバック
  onToggleActive?: (card: Card) => void;
  // Whether to show action buttons (edit, delete, toggle)
  // アクションボタン（編集、削除、切り替え）を表示するかどうか
  showActions?: boolean;
}

/**
 * Get rarity information (label and color) for a given rarity value
 * 指定されたレアリティ値のレアリティ情報（ラベルと色）を取得
 */
const getRarityInfo = (rarity: Rarity) =>
  RARITIES.find((r) => r.value === rarity) || RARITIES[0];

/**
 * List view component for displaying cards in a tabular format
 * カードを表形式で表示するリストビューコンポーネント
 */
export default function CardList({
  cards,
  totalActiveWeight = 0,
  onEdit,
  onDelete,
  onToggleActive,
  showActions = true,
}: CardListProps) {
  const t = useTranslations("cardManager");
  const tCommon = useTranslations("common");
  const tRarity = useTranslations("rarity");
  /**
   * Calculate actual probability for a card based on its weight and total active weight
   * カードの重みと全アクティブ重みから実際の出現確率を計算
   */
  const calculateActualProbability = (dropRate: number, isActive: boolean): string => {
    // Inactive cards don't contribute to probability
    // 非アクティブカードは確率に寄与しない
    if (!isActive || totalActiveWeight === 0) return "-";
    const probability = (dropRate / totalActiveWeight) * 100;
    return `${probability.toFixed(1)}%`;
  };
  if (cards.length === 0) {
    return (
      <p className="text-center text-gray-400">
        {t("messages.emptyCards")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="border-b border-gray-700 text-sm text-gray-400">
          <tr>
            <th className="px-4 py-3">{t("table.image")}</th>
            <th className="px-4 py-3">{t("table.name")}</th>
            <th className="px-4 py-3">{t("table.rarity")}</th>
            <th className="px-4 py-3">{t("table.weight")}</th>
            <th className="px-4 py-3">{t("table.probability")}</th>
            <th className="px-4 py-3">{t("table.status")}</th>
            {showActions && <th className="px-4 py-3">{t("table.actions")}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-700">
          {cards.map((card, index) => {
            const rarityInfo = getRarityInfo(card.rarity);
            const isPaused = !card.is_active;
            // First 4 rows get priority for LCP optimization
            // 最初の4行はLCP最適化のためpriority設定
            const isPriority = index < 4;

            return (
              <tr
                key={card.id}
                className={`hover:bg-gray-700/50 ${isPaused ? "opacity-60" : ""}`}
              >
                {/* Card image thumbnail */}
                {/* カード画像サムネイル */}
                <td className="px-4 py-3">
                  <div className="h-12 w-12 overflow-hidden rounded bg-gray-600">
                    {card.image_url ? (
                      // unoptimized: User-uploaded images are already optimized (400x400 JPEG)
                      // Skip Vercel Image Transformations to reduce usage costs
                      // unoptimized: ユーザーアップロード画像は既に最適化済み(400x400 JPEG)
                      // Vercel Image Transformations をスキップして使用量を削減
                      <Image
                        src={card.image_url}
                        alt={card.name}
                        width={48}
                        height={48}
                        className="h-full w-full object-cover"
                        priority={isPriority}
                        unoptimized
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-gray-500 text-xs">
                        {tCommon("noImage")}
                      </div>
                    )}
                  </div>
                </td>

                {/* Card name and description (expandable if long) */}
                {/* カード名と説明（長い場合は展開可能） */}
                <td className="px-4 py-3">
                  <div>
                    <p className="font-medium text-white">{card.name}</p>
                    {card.description && (
                      /* 説明文の横幅を画像の約4倍（192px = 48px * 4）に制限 */
                      /* Limit description width to about 4x image width (192px = 48px * 4) */
                      <div className="mt-0.5 max-w-48">
                        <ExpandableDescription description={card.description} maxLines={1} size="xs" />
                      </div>
                    )}
                  </div>
                </td>

                {/* Rarity badge */}
                {/* レアリティバッジ */}
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs text-white ${rarityInfo.color}`}
                  >
                    {tRarity(card.rarity)}
                  </span>
                </td>

                {/* Drop weight (relative weight setting) */}
                {/* 出現重み（相対的な重み設定値） */}
                <td className="px-4 py-3 text-sm text-gray-300">
                  {(card.drop_rate * 100).toFixed(1)}
                </td>

                {/* Actual probability (calculated from weights) */}
                {/* 出現確率（重みから計算された実際の確率） */}
                <td className="px-4 py-3 text-sm text-green-400 font-medium">
                  {calculateActualProbability(card.drop_rate, card.is_active)}
                </td>

                {/* Status */}
                {/* ステータス */}
                <td className="px-4 py-3">
                  {isPaused ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-yellow-500"></span>
                      {t("status.paused")}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-xs text-green-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500"></span>
                      {t("status.distributing")}
                    </span>
                  )}
                </td>

                {/* Action buttons */}
                {/* アクションボタン */}
                {showActions && (
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {/* Toggle active/paused */}
                      {/* 有効/停止切り替え */}
                      {onToggleActive && (
                        <button
                          onClick={() => onToggleActive(card)}
                          className={`rounded px-2 py-1 text-xs text-white ${
                            isPaused
                              ? "bg-green-600 hover:bg-green-700"
                              : "bg-yellow-600 hover:bg-yellow-700"
                          }`}
                        >
                          {isPaused ? t("actions.resume") : t("actions.pause")}
                        </button>
                      )}

                      {/* Edit button */}
                      {/* 編集ボタン */}
                      {onEdit && (
                        <button
                          onClick={() => onEdit(card)}
                          className="rounded bg-blue-500 px-2 py-1 text-xs text-white hover:bg-blue-600"
                        >
                          {tCommon("edit")}
                        </button>
                      )}

                      {/* Delete button */}
                      {/* 削除ボタン */}
                      {onDelete && (
                        <button
                          onClick={() => onDelete(card.id)}
                          className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                        >
                          {tCommon("delete")}
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
