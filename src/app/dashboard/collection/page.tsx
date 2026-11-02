import { getSession } from "@/lib/session";
import {
  getUserCards,
  getActiveCardCountsForStreamers,
  getHiddenCollectionStreamerIds,
  getLastObtainedAtByStreamer,
} from "@/lib/dashboard-data";
import {
  countOwnedActiveCardTypes,
  parseStreamerCollectionSort,
  sortCollectedCards,
  sortStreamerCollections,
} from "@/lib/collection-utils";
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
 * 配信者ごとのコレクション1件分（Collection コンポーネントに渡す形）
 */
interface StreamerCollectionEntry {
  streamer: Streamer;
  cards: CardWithDetails[];
  totalActive: number;
  ownedActive: number;
  isComplete?: boolean;
}

/**
 * Collection page showing all user's cards
 * ユーザーの全カードを表示するコレクションページ
 *
 * #1953: `?sort=recent|name|completion` で配信者の並び替え、非表示にした配信者は
 * 通常一覧から外して折りたたみセクションへ回す。
 * Next.js 16 では searchParams は Promise（await が必要）。
 */
export default async function CollectionPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string | string[] }>;
}) {
  const session = await getSession();

  // Session check is handled by layout, but we need session for data fetch
  // セッションチェックはレイアウトで行われるが、データ取得にセッションが必要
  if (!session) {
    return null;
  }

  // 不正な ?sort= は既定（recent）へフォールバックする
  const sortMode = parseStreamerCollectionSort((await searchParams).sort);

  // Fetch user's card collection
  // ユーザーのカードコレクションを取得
  // 非表示設定と最終獲得日時はカード取得と互いに依存しないので並列に取得する。
  // どちらも失敗時は内部で縮退（非表示なし / 日時不明）するため、ここで reject されない。
  // 最終獲得日時は recent 並びでしか使わないので、他のモードではクエリ自体を省く。
  const [userCards, hiddenStreamerIds, lastObtainedAtByStreamer] = await Promise.all([
    getUserCards(session.twitchUserId),
    getHiddenCollectionStreamerIds(session.twitchUserId),
    sortMode === "recent"
      ? getLastObtainedAtByStreamer(session.twitchUserId)
      : Promise.resolve(new Map<string, string | null>()),
  ]);

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
    {} as Record<string, StreamerCollectionEntry>
  );

  // Fetch active card totals per streamer in parallel for progress display
  // 進捗表示用に、配信者ごとのアクティブカード総数とアクティブ所持数を並列取得
  // Note: getUserCards() returns all owned cards including inactive ones,
  // so we must intersect with active cards to get accurate progress counts.
  // getUserCards() は非アクティブカードも含むため、進捗には
  // アクティブカードとの交差で正確な所持数を算出する
  const streamerIds = Object.keys(cardsByStreamer);
  const activeCardCounts = await getActiveCardCountsForStreamers(streamerIds);
  for (const streamerId of streamerIds) {
    const activeCardData = activeCardCounts.get(streamerId) ?? {
      totalActive: 0,
      activeCardIds: new Set<string>(),
    };
    const totalActive = activeCardData.totalActive;
    const ownedActive = countOwnedActiveCardTypes(
      cardsByStreamer[streamerId].cards,
      activeCardData.activeCardIds
    );
    cardsByStreamer[streamerId].totalActive = totalActive;
    cardsByStreamer[streamerId].ownedActive = ownedActive;

    // コンプリート状態の判定
    // isComplete: 現在のアクティブカード全種を所持しているか
    const isComplete = totalActive > 0 && ownedActive >= totalActive;
    cardsByStreamer[streamerId].isComplete = isComplete;
  }

  // #1953: 並び替えて、非表示の配信者を通常一覧から分ける。
  // 並び替えは完成した進捗（ownedActive / totalActive）を使うため、進捗計算の後に行う。
  // 以前の暗黙の順序（レアリティ順ソート→グループ化の副作用で、最高レアを持つ配信者が先）
  // は、明示的な並び替えに置き換わった。
  const sortedEntries = sortStreamerCollections(
    Object.values(cardsByStreamer),
    sortMode,
    lastObtainedAtByStreamer
  );
  const visibleCardsByStreamer: Record<string, StreamerCollectionEntry> = {};
  const hiddenCardsByStreamer: Record<string, StreamerCollectionEntry> = {};
  for (const entry of sortedEntries) {
    const target = hiddenStreamerIds.has(entry.streamer.id)
      ? hiddenCardsByStreamer
      : visibleCardsByStreamer;
    target[entry.streamer.id] = entry;
  }

  return (
    <Collection
      cardsByStreamer={visibleCardsByStreamer}
      hiddenCardsByStreamer={hiddenCardsByStreamer}
      sortMode={sortMode}
    />
  );
}
