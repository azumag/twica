import { getSession } from "@/lib/session";
import {
  getUserCards,
  getActiveCardCountsForCollectedStreamers,
  getHiddenCollectionStreamerIds,
  getLastObtainedAtByStreamer,
} from "@/lib/dashboard-data";
import { getCollectedStreamerIds } from "@/lib/collected-streamers";
import { logger } from "@/lib/logger";
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
  // #2079: 所持コレクションの定義は /trade のコレクション別一覧と同じ関数を使う。
  // 取得に失敗した場合だけ、画面を壊さないよう getUserCards から導いた集合へ縮退する。
  const [userCards, hiddenStreamerIds, lastObtainedAtByStreamer, activeCardCounts, collectedStreamerIds] =
    await Promise.all([
      getUserCards(session.twitchUserId),
      getHiddenCollectionStreamerIds(session.twitchUserId),
      getLastObtainedAtByStreamer(session.twitchUserId),
      getActiveCardCountsForCollectedStreamers(session.twitchUserId),
      getCollectedStreamerIds(session.twitchUserId).catch((error: unknown) => {
        // 一覧は getUserCards から描画できるため、ここで失敗してもページを
        // 壊さない。ただし「全件表示」への縮退を無言にしない。
        logger.warn("collected streamer ids lookup failed; showing the cards-derived set", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
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
  //
  // #2079: 所持コレクションの集合で絞る。getCollectedStreamerIds が失敗したとき
  // （null）は、このページが実際に描画するカードから導いた集合へ縮退し、
  // 一覧が消えるより「取得できた分を出す」方を選ぶ。/trade 側も同じ関数を使うため、
  // 通常時は両画面の配信者集合が一致する。
  const collectedIds = collectedStreamerIds ?? new Set(Object.keys(cardsByStreamer));
  const entries = Object.values(cardsByStreamer).filter((entry) =>
    collectedIds.has(entry.streamer.id)
  );
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
  // The client receives only the owned collections, not just their order ids:
  // a streamer that is missing from `orders` must not remain renderable via
  // cardsByStreamer (#2079).
  const visibleCardsByStreamer = Object.fromEntries(
    entries.map((entry) => [entry.streamer.id, entry])
  ) as Record<string, StreamerCollectionEntry>;

  return (
    <Collection
      cardsByStreamer={visibleCardsByStreamer}
      orders={orders}
      hiddenStreamerIds={[...hiddenStreamerIds]}
    />
  );
}
