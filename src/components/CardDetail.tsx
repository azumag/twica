import Image from "next/image";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Streamer, Card } from "@/types/database";
import { RARITIES } from "@/lib/constants";
import type { Rarity } from "@/types/database";
import { isVideoCard } from "@/lib/card-media";

/**
 * Get rarity information (label and color) for a given rarity value
 * 指定されたレアリティ値のレアリティ情報（ラベルと色）を取得
 */
const getRarityInfo = (rarity: Rarity) =>
  RARITIES.find((r) => r.value === rarity) || RARITIES[0];

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

interface CardDetailProps {
  card: CardWithDetails;
  streamer: Streamer;
}

/**
 * CardDetail - Server component that displays detailed card information
 * カード詳細表示用サーバーコンポーネント
 *
 * Shows the card image in full size (especially for portrait images),
 * along with title, description, and owned count.
 * カード画像をフルサイズで表示（特に縦長画像の場合）、
 * タイトル、説明、所有枚数も表示
 */
export default async function CardDetail({ card, streamer }: CardDetailProps) {
  const t = await getTranslations("cardDetail");
  const tCollection = await getTranslations("collection");
  const tCardManager = await getTranslations("cardManager");

  const rarityInfo = getRarityInfo(card.rarity);

  return (
    <div className="min-h-screen bg-gray-900 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-2xl">
        {/* Back link to collection */}
        {/* コレクションへの戻りリンク */}
        <Link
          href={`/collection/${streamer.id}`}
          className="mb-6 inline-flex items-center text-purple-400 hover:text-purple-300 transition-colors"
        >
          <span className="mr-2">←</span>
          {t("backToCollection")}
        </Link>

        {/* Card container */}
        {/* カードコンテナ */}
        <div className="rounded-xl bg-gray-800 overflow-hidden shadow-lg">
          {/* Card image - displayed without cropping */}
          {/* カード画像 - トリミングなしで表示 */}
          {card.image_url ? (
            <div className="relative w-full flex justify-center bg-gray-700">
              {isVideoCard(card.media_type) ? (
                <video
                  src={card.image_url}
                  className="w-full h-auto max-h-[70vh] object-contain"
                  controls
                  playsInline
                  preload="metadata"
                  aria-label={card.name}
                />
              ) : (
                // unoptimized: Images are already optimized during upload
                // unoptimized: アップロード時に既に最適化済み
                <Image
                  src={card.image_url}
                  alt={card.name}
                  width={800}
                  height={1118}
                  className="w-full h-auto max-h-[70vh] object-contain"
                  priority
                  unoptimized
                />
              )}
            </div>
          ) : (
            <div className="w-full aspect-square bg-gray-700 flex items-center justify-center text-gray-500">
              No Image
            </div>
          )}

          {/* Card info section */}
          {/* カード情報セクション */}
          <div className="p-6">
            {/* Title and rarity */}
            {/* タイトルとレアリティ */}
            <div className="mb-4 flex flex-wrap items-start gap-2">
              <h1 className="mr-auto text-2xl font-bold text-white">{card.name}</h1>
              {!card.is_active && (
                <span className="rounded-full bg-amber-500/15 px-3 py-1 text-sm font-medium text-amber-300 ring-1 ring-inset ring-amber-400/30">
                  {tCardManager("status.paused")}
                </span>
              )}
              <span
                className={`rounded-full px-3 py-1 text-white text-sm shrink-0 ${rarityInfo.color}`}
              >
                {rarityInfo.label}
              </span>
            </div>

            {/* Description */}
            {/* 説明 */}
            {card.description && (
              <p className="text-gray-300 mb-4 whitespace-pre-wrap">
                {card.description}
              </p>
            )}

            {/* Owned count */}
            {/* 所有枚数 */}
            <div className="flex items-center gap-2 text-gray-400">
              <span className="text-lg">
                {t("ownedCount", { count: card.count })}
              </span>
            </div>
          </div>
        </div>

        {/* Back to full collection link */}
        {/* フルコレクションへの戻りリンク */}
        <div className="mt-8 text-center">
          <Link
            href="/dashboard/collection"
            className="text-purple-400 hover:text-purple-300 transition-colors"
          >
            {tCollection("viewCollection")} →
          </Link>
        </div>
      </div>
    </div>
  );
}
