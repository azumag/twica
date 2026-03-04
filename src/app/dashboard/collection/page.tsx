import { getSession } from "@/lib/session";
import { getUserCards, getActiveCardsForStreamer } from "@/lib/dashboard-data";
import { RARITY_ORDER } from "@/lib/constants";
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
      const activeOwnedCards = cardsByStreamer[streamerId].cards.filter(
        (c) => activeCardIds.has(c.id)
      );
      return {
        streamerId,
        totalActive: activeCards.length,
        ownedActive: activeOwnedCards.length,
        activeOwnedCards,
      };
    })
  );
  for (const { streamerId, totalActive, ownedActive, activeOwnedCards } of activeCardData) {
    // Align My Collection with streamer collection page behavior:
    // only active cards that the user owns are shown and counted.
    // マイコレクションを配信者別コレクションと揃えるため、
    // 「配布中かつ所持」のカードのみ表示・集計する。
    cardsByStreamer[streamerId].cards = activeOwnedCards;
    cardsByStreamer[streamerId].totalActive = totalActive;
    cardsByStreamer[streamerId].ownedActive = ownedActive;

    // コンプリート状態の判定
    // isComplete: 現在のアクティブカード全種を所持しているか
    const isComplete = totalActive > 0 && ownedActive >= totalActive;
    cardsByStreamer[streamerId].isComplete = isComplete;

    // Hide streamers where user has no active owned cards
    // ユーザーが配布中カードを1枚も所持していない配信者は非表示
    if (activeOwnedCards.length === 0) {
      delete cardsByStreamer[streamerId];
    }
  }

  return <Collection cardsByStreamer={cardsByStreamer} />;
}
