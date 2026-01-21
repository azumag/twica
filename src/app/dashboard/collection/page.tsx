import { getSession } from "@/lib/session";
import { getUserCards } from "@/lib/dashboard-data";
import { RARITY_ORDER } from "@/lib/constants";
import Collection from "@/components/Collection";
import { UI_STRINGS } from "@/lib/constants";
import type { Card, Streamer } from "@/types/database";

export const dynamic = "force-dynamic";

/**
 * Extended card interface with streamer and count information
 * 配信者情報と所持数を含む拡張カードインターフェース
 */
interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

/**
 * Collection page showing all user's cards
 * ユーザーの全カードを表示するコレクションページ
 */
export default async function CollectionPage() {
  const session = await getSession();

  // Session check is handled by layout, but we need session for data fetch
  // セッションチェックはレイアウトで行われるが、データ取得にセッションが必要
  if (!session) {
    return null;
  }

  // Fetch user's card collection
  // ユーザーのカードコレクションを取得
  const userCards = await getUserCards(session.twitchUserId);

  // Sort cards by rarity (legendary first)
  // レアリティでソート（レジェンダリーが先頭）
  userCards.sort((a, b) => {
    return RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
  });

  // Group cards by streamer for organized display
  // 整理された表示のためにカードを配信者でグループ化
  const cardsByStreamer = userCards.reduce(
    (acc, card) => {
      const streamerId = card.streamer.id;
      if (!acc[streamerId]) {
        acc[streamerId] = {
          streamer: card.streamer,
          cards: [],
        };
      }
      acc[streamerId].cards.push(card);
      return acc;
    },
    {} as Record<string, { streamer: Streamer; cards: CardWithDetails[] }>
  );

  // Calculate collection statistics
  // コレクション統計を計算
  const stats = {
    total: userCards.reduce((sum, c) => sum + c.count, 0),
    unique: userCards.length,
    legendary: userCards.filter((c) => c.rarity === "legendary").length,
    epic: userCards.filter((c) => c.rarity === "epic").length,
    rare: userCards.filter((c) => c.rarity === "rare").length,
    common: userCards.filter((c) => c.rarity === "common").length,
  };

  return (
    <div>
      {/* Page header */}
      {/* ページヘッダー */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">
          {UI_STRINGS.COLLECTION_PAGE.TITLE}
        </h1>
        <p className="mt-2 text-gray-400">
          {UI_STRINGS.COLLECTION_PAGE.DESCRIPTION}
        </p>
      </div>

      {/* Collection component with full display */}
      {/* フル表示のコレクションコンポーネント */}
      <Collection cardsByStreamer={cardsByStreamer} stats={stats} />
    </div>
  );
}
