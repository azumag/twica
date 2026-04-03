import { getSession } from "@/lib/session";
import { getUserCards, getActiveCardsForStreamer } from "@/lib/dashboard-data";
import { countOwnedActiveCardTypes, sortCollectedCards } from "@/lib/collection-utils";
import Collection from "@/components/Collection";
import type { Card, Streamer } from "@/types/database";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

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
  const sortedUserCards = sortCollectedCards(userCards);

  // Group cards by streamer for organized display
  // 整理された表示のためにカードを配信者でグループ化
  const cardsByStreamer = sortedUserCards.reduce(
    (acc, card) => {
      const streamerId = card.streamer.id;
      if (!acc[streamerId]) {
        acc[streamerId] = {
          streamer: card.streamer,
          cards: [],
          totalActive: 0,
          ownedActive: 0,
        };
      }
      acc[streamerId].cards.push(card);
      return acc;
    },
    {} as Record<string, { streamer: Streamer; cards: CardWithDetails[]; totalActive: number; ownedActive: number; isComplete?: boolean }>
  );

  // Fetch active card totals per streamer in parallel for progress display
  // 進捗表示用に、配信者ごとのアクティブカード総数とアクティブ所持数を並列取得
  // Note: getUserCards() returns all owned cards including inactive ones,
  // so we must intersect with active cards to get accurate progress counts.
  // getUserCards() は非アクティブカードも含むため、進捗には
  // アクティブカードとの交差で正確な所持数を算出する
  const streamerIds = Object.keys(cardsByStreamer);
  const activeCardData = await Promise.all(
    streamerIds.map(async (streamerId) => {
      const activeCards = await getActiveCardsForStreamer(streamerId);
      const activeCardIds = new Set(activeCards.map((c) => c.id));
      return {
        streamerId,
        totalActive: activeCards.length,
        ownedActive: countOwnedActiveCardTypes(cardsByStreamer[streamerId].cards, activeCardIds),
      };
    })
  );
  for (const { streamerId, totalActive, ownedActive } of activeCardData) {
    cardsByStreamer[streamerId].totalActive = totalActive;
    cardsByStreamer[streamerId].ownedActive = ownedActive;

    // コンプリート状態の判定
    // isComplete: 現在のアクティブカード全種を所持しているか
    const isComplete = totalActive > 0 && ownedActive >= totalActive;
    cardsByStreamer[streamerId].isComplete = isComplete;
  }

  return <Collection cardsByStreamer={cardsByStreamer} />;
}
