"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { cardImageFitClass, cardImageFitStyle } from "@/lib/card-image-style";

/**
 * カードアルバム表示（3×3固定・画像のみ） — 視聴者からの機能要望 (#1765)
 *
 * 要望の要点:
 *  - 端末幅によって横に並ぶ枚数が変わる現状のグリッドを、3×3 の決まった並びで見たい
 *  - 名前・レアリティなどの文字を出さず、画像だけを並べて眺めたい
 *  - 将来は「アルバム上で完成するパズル」のようなガチャへ広げたい（＝穴あきの枠）
 *
 * そのため、このコンポーネントは:
 *  - 列数は常に 3（レスポンシブ分岐を一切持たない。`sm:`/`lg:` 等を書かない）
 *  - 1ページ = 9 枠固定。最終ページも空き枠で埋めて常に 3×3 の枠を描く
 *  - タイルに表示するのは画像のみ（名前・レアリティ・枚数バッジを出さない。
 *    カード名は画像の alt としてのみ保持し、読み上げとフォールバックに使う）
 *  - 未所持カードは画像を出さず「空きスロット」として残す（アルバム＝所持カードの
 *    コレクション。未所持を画像で埋めると要望の「集めた画像を並べる」体験と
 *    パズルの穴の両方が壊れるため、公開モードでもアルバムでは伏せる）
 *
 * Card album view: a fixed 3×3 image-only grid (no names / no rarity badges) with
 * page navigation. Unowned cards stay as empty slots so the album reads as a
 * collection with gaps, which is also the base for the requested puzzle idea.
 */

// 3×3 固定 = 1ページ 9 枚
export const ALBUM_PAGE_SIZE = 9;

export interface AlbumCard {
  id: string;
  name: string;
  image_url: string | null;
  // 余白（fit）モードで生成されたカードの余白色（Issue #899）
  image_padding_color?: string | null;
  isOwned?: boolean;
}

/**
 * サーバー→クライアントへ渡すシリアライズ済み翻訳（関数は渡せない）。
 * Serialized translations passed from the server component.
 */
export interface AlbumTranslations {
  // 「表示」ラベル（切替UI）
  viewLabel: string;
  // 「カード」表示（グリッド）への切替
  gridView: string;
  // 「アルバム」表示への切替
  albumView: string;
  // ページ位置。"{page}" と "{total}" を置換して使う
  pageIndicator: string;
  prevPage: string;
  nextPage: string;
  // 空きスロットの読み上げラベル
  emptySlot: string;
  // タイルの読み上げラベル。"{number}" を置換して使う
  cardPosition: string;
}

interface CardAlbumViewProps {
  cards: AlbumCard[];
  streamerId: string;
  translations: AlbumTranslations;
}

export default function CardAlbumView({
  cards,
  streamerId,
  translations,
}: CardAlbumViewProps) {
  const [page, setPage] = useState(0);

  const totalPages = Math.max(1, Math.ceil(cards.length / ALBUM_PAGE_SIZE));
  // カード数が減っても（パック絞り込みの切替など）表示中ページが範囲外にならないようにする
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * ALBUM_PAGE_SIZE;
  const pageCards = cards.slice(pageStart, pageStart + ALBUM_PAGE_SIZE);
  // 最終ページも 3×3 の枠を埋める（null = 追加の空きスロット）
  const slots: (AlbumCard | null)[] = [
    ...pageCards,
    ...Array<null>(ALBUM_PAGE_SIZE - pageCards.length).fill(null),
  ];

  const fillTemplate = (template: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.replace(`{${key}}`, value),
      template
    );

  return (
    <div data-testid="card-album">
      {/* 3×3 固定: 列数は常に 3。端末幅によって並ぶ枚数が変わらないよう
          レスポンシブなグリッド指定は使わない。 */}
      <div
        data-testid="card-album-grid"
        className="mx-auto grid w-full max-w-sm grid-cols-3 gap-2"
      >
        {slots.map((card, index) => {
          const slotKey = card ? card.id : `empty-slot-${index}`;
          const position = pageStart + index + 1;
          const positionLabel = fillTemplate(translations.cardPosition, {
            number: String(position),
          });

          // 空きスロット: 未所持カード、および最終ページの余り枠
          if (!card || card.isOwned === false) {
            return (
              <div
                key={slotKey}
                role="img"
                aria-label={translations.emptySlot}
                className="aspect-square rounded-lg border border-dashed border-gray-700 bg-gray-800/60"
              />
            );
          }

          return (
            <div
              key={slotKey}
              className="aspect-square overflow-hidden rounded-lg bg-gray-700 transition-transform hover:scale-105"
            >
              <Link
                href={`/collection/${streamerId}/card/${card.id}`}
                prefetch={false}
                aria-label={positionLabel}
                className="block h-full w-full rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
              >
                {card.image_url ? (
                  <Image
                    src={getOptimizedImageUrl(card.image_url, "thumbnail")}
                    alt={card.name}
                    width={300}
                    height={300}
                    className={`h-full w-full ${cardImageFitClass(card.image_padding_color)}`}
                    style={cardImageFitStyle(card.image_padding_color)}
                    unoptimized
                  />
                ) : (
                  // 画像未設定のカードはタイル内に文字を出さない（画像のみ表示のため）
                  <div
                    aria-hidden="true"
                    className="h-full w-full bg-gray-600"
                  />
                )}
              </Link>
            </div>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => setPage(Math.max(0, safePage - 1))}
            disabled={safePage === 0}
            aria-label={translations.prevPage}
            className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {"\u2190"}
          </button>
          <span className="text-sm text-gray-400" data-testid="card-album-page">
            {fillTemplate(translations.pageIndicator, {
              page: String(safePage + 1),
              total: String(totalPages),
            })}
          </span>
          <button
            type="button"
            onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
            disabled={safePage >= totalPages - 1}
            aria-label={translations.nextPage}
            className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {"\u2192"}
          </button>
        </div>
      )}
    </div>
  );
}
