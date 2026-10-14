"use client";

import { useId, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { getOptimizedImageUrl } from "@/lib/image-utils";
import { cardImageFitClass, cardImageFitStyle } from "@/lib/card-image-style";
import {
  ALBUM_GRID_SIZES,
  DEFAULT_ALBUM_GRID_SIZE,
  normalizeAlbumGridSize,
} from "@/lib/collection-album";

/**
 * カードアルバム表示（画像のみ・N×N可変） — 視聴者からの機能要望 (#1765)
 *
 * 要望の要点:
 *  - 端末幅によって横に並ぶ枚数が変わる現状のグリッドを、決まった並びで見たい
 *  - 名前・レアリティなどの文字を出さず、画像だけを並べて眺めたい
 *  - 将来は「アルバム上で完成するパズル」のようなガチャへ広げたい（＝穴あきの枠）
 *
 * そのため、このコンポーネントは:
 *  - 列数・行数は呼び出し側が渡す N（既定 3）。1ページ = N×N 枠。
 *    レスポンシブな列数指定（`sm:` 等）は一切持たない＝端末幅で並びが変わらない
 *  - 1ページの枠数は常に N×N。最終ページも空き枠で埋める
 *  - タイルに表示するのは画像のみ（名前・レアリティ・枚数バッジを出さない。
 *    カード名は画像の alt とリンクの accessible name に保持し、読み上げに使う）
 *  - 未所持カードは画像を出さず「空きスロット」として残す（アルバム＝所持カードの
 *    コレクション。未所持を画像で埋めると要望の「集めた画像を並べる」体験と
 *    パズルの穴の両方が壊れるため、公開モードでもアルバムでは伏せる）
 *
 * 並び (N) は配信者がコレクション(パック)ごとに指定した既定値を初期値とし、
 * 閲覧者がその場で変更できる。制御コンポーネントとして使う場合は gridSize と
 * onGridSizeChange を両方渡す（親が選択を保持する）。どちらも未指定なら
 * 内部 state で既定 N から始まる。
 *
 * Card album view: an image-only N×N grid (no names / no rarity badges) with page
 * navigation and a viewer-selectable grid size. Unowned cards stay as empty slots
 * so the album reads as a collection with gaps, which is also the base for the
 * requested puzzle idea.
 */

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
  // 並び (N×N) セレクタのラベル
  gridSizeLabel: string;
  // 並びの選択肢。"{size}" を置換して使う（例: "3×3"）
  gridSizeOption: string;
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
  // アルバムの並び N（N×N）。未指定は既定 3。
  gridSize?: number;
  // 並びの変更通知。渡された場合は制御コンポーネントとして扱う。
  onGridSizeChange?: (size: number) => void;
}

export default function CardAlbumView({
  cards,
  streamerId,
  translations,
  gridSize,
  onGridSizeChange,
}: CardAlbumViewProps) {
  const [page, setPage] = useState(0);
  // 同じページに複数のアルバムが載っても id が衝突しないようにする。
  const gridSizeSelectId = useId();
  const [internalGridSize, setInternalGridSize] = useState(
    () => normalizeAlbumGridSize(gridSize) ?? DEFAULT_ALBUM_GRID_SIZE
  );

  const size =
    onGridSizeChange !== undefined
      ? normalizeAlbumGridSize(gridSize) ?? DEFAULT_ALBUM_GRID_SIZE
      : internalGridSize;
  const pageSize = size * size;

  const totalPages = Math.max(1, Math.ceil(cards.length / pageSize));
  // カード数・並びが変わっても（パック絞り込みの切替など）表示中ページが
  // 範囲外にならないようにする
  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * pageSize;
  const pageCards = cards.slice(pageStart, pageStart + pageSize);
  // 最終ページも N×N の枠を埋める（null = 追加の空きスロット）
  const slots: (AlbumCard | null)[] = [
    ...pageCards,
    ...Array<null>(pageSize - pageCards.length).fill(null),
  ];

  // 並びが変わるとページ数も変わるため、選択時は先頭ページへ戻す。
  const selectGridSize = (next: number) => {
    const normalized = normalizeAlbumGridSize(next);
    if (normalized === null || normalized === size) return;
    setPage(0);
    if (onGridSizeChange) {
      onGridSizeChange(normalized);
    } else {
      setInternalGridSize(normalized);
    }
  };

  // 同じトークンが複数回現れても全て置換する（gridSizeOption の "{size}×{size}" など）。
  const fillTemplate = (template: string, values: Record<string, string>) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.split(`{${key}}`).join(value),
      template
    );

  return (
    <div data-testid="card-album">
      {/* 並び (N×N) の選択。配信者の既定値を初期値に、閲覧者がその場で変更できる。 */}
      <div className="mb-3 flex items-center justify-center gap-2">
        <label
          htmlFor={gridSizeSelectId}
          className="text-sm text-gray-400"
        >
          {translations.gridSizeLabel}
        </label>
        <select
          id={gridSizeSelectId}
          data-testid="card-album-grid-size"
          value={String(size)}
          onChange={(event) => selectGridSize(Number(event.target.value))}
          className="rounded-lg border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-gray-200"
        >
          {ALBUM_GRID_SIZES.map((option) => (
            <option key={option} value={String(option)}>
              {fillTemplate(translations.gridSizeOption, {
                size: String(option),
              })}
            </option>
          ))}
        </select>
      </div>

      {/* N×N 固定: 列数は常に N。端末幅によって並ぶ枚数が変わらないよう
          レスポンシブなグリッド指定は使わず、inline style で列数を決める。 */}
      <div
        data-testid="card-album-grid"
        className="mx-auto grid w-full gap-2"
        style={{
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          // 3×3 のときは従来と同じ幅（max-w-sm 相当）に収め、大きい N では
          // 読み取れる大きさを保つため最大 9 列分まで広げる。
          maxWidth: `${Math.min(size, 9) * 8}rem`,
        }}
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

          // aria-label は画像の alt より優先されるため、画像なしでも位置とカード名を
          // 読めるようにする。外向きの ring は overflow-hidden 内のリンクで切れるので、
          // 子リンクの focus-visible に応じてラッパー自身に描き、画像の角丸は維持する。
          return (
            <div
              key={slotKey}
              className="aspect-square overflow-hidden rounded-lg bg-gray-700 transition-transform hover:scale-105 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-purple-400"
            >
              <Link
                href={`/collection/${streamerId}/card/${card.id}`}
                prefetch={false}
                aria-label={`${positionLabel}: ${card.name}`}
                className="block h-full w-full rounded-lg focus:outline-none"
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
