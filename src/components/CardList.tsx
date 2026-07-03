"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import type { Card, Rarity } from "@/types/database";
import { formatRarityLabel, getRarityDisplayInfo } from "@/lib/rarity";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { getIssuanceInfo } from "@/lib/card-issuance";
import ExpandableDescription from "./ExpandableDescription";

interface CardListProps {
  // Array of cards to display
  // 表示するカードの配列
  cards: Card[];
  // Total weight of all active cards (for calculating actual probability)
  // 全アクティブカードの重み合計（実際の出現確率計算用）
  totalActiveWeight?: number;
  // Issue #580(#576 フェーズ3): カードID→実際の出現確率(%, 0-100)の事前計算済み
  // マップ。指定されたカードは totalActiveWeight ベースの単純な比率計算より
  // このマップの値を優先して表示する。呼び出し元(CardManager)がパック絞込+
  // 自動モード時に computeEffectiveWeights(#579) で正しい実効確率を算出して
  // 渡すためのフック。未指定/該当カードなしの場合は従来の
  // totalActiveWeight 比率計算にフォールバックする(APIを最小限に保つ)。
  // A pre-computed map of cardId -> actual display probability (%, 0-100).
  // When present for a card, this value is shown instead of the simple
  // totalActiveWeight ratio. Lets the caller (CardManager) supply
  // computeEffectiveWeights-derived (Issue #579) probabilities for the
  // pack-filtered auto-mode case, keeping this component's API minimal.
  probabilityOverrides?: Map<string, number>;
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
  // Callback when the thumbnail image is clicked (opens an enlarged view)
  // Receives the card and the triggering button so the caller can restore focus after closing
  // サムネイル画像クリック時のコールバック（拡大表示モーダルを開く）
  // 呼び出し元でフォーカス復元できるよう、元ボタンも引数で渡す
  onImageClick?: (card: Card, trigger: HTMLButtonElement) => void;
}

/**
 * Get rarity information (label and color) for a given rarity value
 * 指定されたレアリティ値のレアリティ情報（ラベルと色）を取得
 */
const getRarityInfo = (rarity: Rarity) => getRarityDisplayInfo(rarity);

/**
 * List view component for displaying cards in a tabular format
 * カードを表形式で表示するリストビューコンポーネント
 */
export default function CardList({
  cards,
  totalActiveWeight = 0,
  probabilityOverrides,
  onEdit,
  onDelete,
  onToggleActive,
  showActions = true,
  onImageClick,
}: CardListProps) {
  const t = useTranslations("cardManager");
  const tCommon = useTranslations("common");
  const tRarity = useTranslations("rarity");
  /**
   * Calculate actual probability for a card based on its weight and total active weight
   * カードの重みと全アクティブ重みから実際の出現確率を計算
   */
  const calculateActualProbability = (card: Card): string => {
    // Inactive cards don't contribute to probability
    // 非アクティブカードは確率に寄与しない
    if (!card.is_active) return "-";
    // Issue #580: 事前計算済みの実効確率があれば優先する
    const override = probabilityOverrides?.get(card.id);
    if (override !== undefined) {
      return `${override.toFixed(1)}%`;
    }
    if (totalActiveWeight === 0) return "-";
    const probability = (card.drop_rate / totalActiveWeight) * 100;
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
      {/* table-fixed で列幅を固定、列幅はヘッダーで明示指定 */}
      {/* table-fixed locks column widths, explicitly set in header */}
      <table className="w-full text-left table-fixed">
        <thead className="border-b border-gray-700 text-sm text-gray-400">
          <tr>
            {/* 画像列：固定幅 80px */}
            {/* Image column: fixed width 80px */}
            <th className="px-4 py-3 w-20">{t("table.image")}</th>
            {/* 名前列：残りスペースを使用（最小200px） */}
            {/* Name column: uses remaining space (min 200px) */}
            <th className="px-4 py-3 min-w-[200px]">{t("table.name")}</th>
            {/* レアリティ列：固定幅 100px */}
            {/* Rarity column: fixed width 100px */}
            <th className="px-4 py-3 w-24">{t("table.rarity")}</th>
            {/* 重み列：固定幅 80px */}
            {/* Weight column: fixed width 80px */}
            <th className="px-4 py-3 w-20">{t("table.weight")}</th>
            {/* 確率列：固定幅 80px */}
            {/* Probability column: fixed width 80px */}
            <th className="px-4 py-3 w-20">{t("table.probability")}</th>
            {/* 発行数列：固定幅 112px（Issue #542。無制限カードは"-"のみで空欄） */}
            {/* Issuance column: fixed width 112px (Issue #542. Shows "-" for unlimited cards) */}
            <th className="px-4 py-3 w-28">{t("table.issuance")}</th>
            {/* ステータス列：固定幅 100px */}
            {/* Status column: fixed width 100px */}
            <th className="px-4 py-3 w-24">{t("table.status")}</th>
            {/* 操作列：固定幅 200px */}
            {/* Actions column: fixed width 200px */}
            {showActions && <th className="px-4 py-3 w-48">{t("table.actions")}</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-700">
          {cards.map((card, index) => {
            const rarityInfo = getRarityInfo(card.rarity);
            const isPaused = !card.is_active;
            // First 4 rows get priority for LCP optimization
            // 最初の4行はLCP最適化のためpriority設定
            const isPriority = index < 4;
            // Issue #542: limited-issuance cards only (null for unlimited cards)
            const issuanceInfo = getIssuanceInfo(card.max_issuance_count, card.issued_count);

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
                      onImageClick ? (
                        // 拡大表示ハンドラがある場合はボタンでラップし、クリックで拡大モーダルを開く
                        // When the zoom handler is provided, wrap the image in a button to trigger the modal
                        (() => {
                          const imageUrl = card.image_url;
                          return (
                            <button
                              type="button"
                              onClick={(e) => onImageClick(card, e.currentTarget)}
                              className="block h-full w-full cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
                              aria-label={t("actions.enlargeImage", { name: card.name })}
                            >
                              <Image
                                src={getOptimizedImageUrl(imageUrl, "icon")}
                                alt={card.name}
                                width={48}
                                height={48}
                                className="h-full w-full object-cover"
                                priority={isPriority}
                                unoptimized
                              />
                            </button>
                          );
                        })()
                      ) : (
                        <Image
                          src={getOptimizedImageUrl(card.image_url, "icon")}
                          alt={card.name}
                          width={48}
                          height={48}
                          className="h-full w-full object-cover"
                          priority={isPriority}
                          unoptimized
                        />
                      )
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
                  <div className="overflow-hidden">
                    {/* カード名は1行に省略 */}
                    {/* Card name truncated to 1 line */}
                    <p className="font-medium text-white truncate">{card.name}</p>
                    {card.description && (
                      /* 説明文は2行に制限、展開時も最大高さ80pxに制限 */
                      /* Limit description to 2 lines, max 80px height when expanded */
                      <div className="mt-0.5">
                        <ExpandableDescription
                          description={card.description}
                          maxLines={2}
                          size="xs"
                          maxExpandedHeight={80}
                        />
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
                    {formatRarityLabel(card.rarity, tRarity)}
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
                  {calculateActualProbability(card)}
                </td>

                {/* Issued / max issuance count (Issue #542) */}
                {/* 発行済み / 発行可能枚数（Issue #542） */}
                <td className="px-4 py-3 text-sm">
                  {issuanceInfo ? (
                    <div className="flex flex-col items-start gap-1">
                      <span
                        className={
                          issuanceInfo.soldOut
                            ? "font-medium text-red-400"
                            : issuanceInfo.lowRemaining
                              ? "font-medium text-yellow-400"
                              : "text-gray-300"
                        }
                      >
                        {t("issuance.issuedOfMax", { issued: issuanceInfo.issued, max: issuanceInfo.max })}
                      </span>
                      {issuanceInfo.soldOut && (
                        <span className="inline-flex items-center rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-400">
                          {t("issuance.soldOut")}
                        </span>
                      )}
                      {!issuanceInfo.soldOut && issuanceInfo.lowRemaining && (
                        <span className="inline-flex items-center rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-400">
                          {t("issuance.lowRemaining")}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-gray-500">-</span>
                  )}
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
