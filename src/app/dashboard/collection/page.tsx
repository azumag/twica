import { getSession } from "@/lib/session";
import {
  getUserCards,
  getActiveCardCountsForCollectedStreamers,
  getHiddenCollectionStreamerIds,
  getLastObtainedAtByStreamer,
} from "@/lib/dashboard-data";
import {
  countOwnedActiveCardTypes,
  sortCollectedCards,
  sortStreamerCollections,
  type StreamerCollectionSortMode,
  type StreamerCollectionSortOrder,
} from "@/lib/collection-utils";
import Collection from "@/components/Collection";
import type { Card, Streamer } from "@/types/database";

// Note: Page is automatically dynamic due to cookies() usage in getSession()
// cookies()使用により自動的に動的ページになるため、force-dynamicは不要

const STREAMER_SORT_MODES: readonly StreamerCollectionSortMode[] = ["recent", "name", "completion"];
// #2032: 向きはモード切替とは独立に選べるため、両方向の並びをあらかじめ確定させて渡す。
const STREAMER_SORT_ORDERS: readonly StreamerCollectionSortOrder[] = ["asc", "desc"];

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
 * 並び替え・非表示の切替はブラウザ内で即時に行う（サーバー往復と米国 colo → DB(ソウル) の
 * 往復で 2 秒超かかった実測による。Refs #1953）。そのため全モードの並びをここで確定させ、
 * ID 配列だけを渡す（比較ロジックを client に複製しない）。
 * `?sort=` の解釈は client 側（CollectionStreamerList が URL から読む）で行う。
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
  // 非表示設定と最終獲得日時はカード取得と互いに依存しないので並列に取得する。
  // どちらも失敗時は内部で縮退（非表示なし / 日時不明）するため、ここで reject されない。
  // 最終獲得日時は、client 側で recent に切り替えても即時に並べられるよう ?sort= に関わらず常に取得する。
  const [userCards, hiddenStreamerIds, lastObtainedAtByStreamer, activeCardCounts] =
    await Promise.all([
      getUserCards(session.twitchUserId),
      getHiddenCollectionStreamerIds(session.twitchUserId),
      getLastObtainedAtByStreamer(session.twitchUserId),
      getActiveCardCountsForCollectedStreamers(session.twitchUserId),
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

  // activeCardCounts は Promise.all で getUserCards と並列に取得済み。
  // 所持配信者のみを対象とするため streamerIds の事前取得が不要で、直列2段を解消した。
  for (const streamerId of Object.keys(cardsByStreamer)) {
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

  // #1953: 3モードそれぞれの並び順（配信者ID配列）を、非表示の配信者も含めて確定させる。
  // 並び替えは完成した進捗（ownedActive / totalActive）を使うため、進捗計算の後に行う。
  // 非表示かどうかの振り分けと、モード切替時の並び替えは client 側（CollectionStreamerList）が行う。
  // 以前の暗黙の順序（レアリティ順ソート→グループ化の副作用で、最高レアを持つ配信者が先）
  // は、明示的な並び替えに置き換わった。
  const entries = Object.values(cardsByStreamer);
  const orders = Object.fromEntries(
    STREAMER_SORT_MODES.map((mode) => [
      mode,
      Object.fromEntries(
        STREAMER_SORT_ORDERS.map((order) => [
          order,
          sortStreamerCollections(entries, mode, lastObtainedAtByStreamer, order).map(
            (e) => e.streamer.id
          ),
        ])
      ),
    ])
  ) as Record<StreamerCollectionSortMode, Record<StreamerCollectionSortOrder, string[]>>;

  return (
    <Collection
      cardsByStreamer={cardsByStreamer}
      orders={orders}
      hiddenStreamerIds={[...hiddenStreamerIds]}
    />
  );
}
