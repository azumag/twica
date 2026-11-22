import { and, eq, sql, type SQL } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { withDbRetry } from "@/lib/db/retry";
import {
  cards as cardsTable,
  userCards as userCardsTable,
  users as usersTable,
} from "@/lib/db/schema";

/**
 * "持っているコレクション" の単一の定義 (#2079)。
 *
 * トレードハブ (/trade) のコレクション別一覧と、展開 API
 * (GET /api/trades/collections/[streamerId]) の権限確認は、同じ
 * 「その配信者のカードを1枚以上 user_cards に持っている」という定義を
 * 共有しなければならない。片方だけが別の定義になると、一覧に出ている
 * コレクションを展開できない（またはその逆）状態が生まれる。
 *
 * このサブクエリがその定義の正本である。カードの is_active は条件にしない
 * （非アクティブになったカードでも、所持していればコレクションに含める。
 * これはマイコレクション一覧が getUserCards() の結果を `card.streamer` で
 * グルーピングする定義と同じ）。
 *
 * SQL 側の IN 副問い合わせとして使える形にしてあるため、トレードの一覧
 * （出品・オークション）は viewer の所持配信者をこの1か所から参照する。
 * TS 側で1配信者だけを確かめる展開 API は getCollectedStreamerIds() を使う。
 * どちらもこのサブクエリを経由するので、定義は1か所に閉じている。
 */
export function collectedStreamerIdsSubquery(twitchUserId: string): SQL {
  return sql`(
    SELECT DISTINCT collected_card.streamer_id
    FROM ${userCardsTable} AS collected_owned
    INNER JOIN ${usersTable} AS collected_user
      ON collected_user.id = collected_owned.user_id
    INNER JOIN ${cardsTable} AS collected_card
      ON collected_card.id = collected_owned.card_id
    WHERE collected_user.twitch_user_id = ${twitchUserId}
  )`;
}

/**
 * 視聴者がカードを持っている配信者IDの集合を、`streamerId` の1件に絞って返す。
 *
 * 用途は展開 API の権限確認だけ。展開 API は「持っていないコレクション」を
 * 404 にする必要があるが、一覧クエリが0行だっただけでは「持っていない」のか
 * 「持っているが出品・オークションが無い」のか区別できないため、この関数で
 * 先に確かめる。`streamerId` を必須にして、全コレクションを数える用途
 * （一覧側は SQL の collectedStreamerIdsSubquery が担う）と混ざらないようにする。
 *
 * 読み取り専用なので withDbRetry は idempotent: true。失敗時は呼び出し側が
 * 縮退を決められるよう例外をそのまま返す（API は 500 にする）。
 */
export async function getCollectedStreamerIds(
  twitchUserId: string,
  streamerId: string,
): Promise<Set<string>> {
  const inCollected = sql<boolean>`${cardsTable.streamer_id} IN ${collectedStreamerIdsSubquery(twitchUserId)}`;
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .selectDistinct({ streamerId: cardsTable.streamer_id })
        .from(cardsTable)
        .where(and(inCollected, eq(cardsTable.streamer_id, streamerId)));
    },
    "collected-streamers:ids",
    { idempotent: true },
  );
  return new Set(rows.map((row) => row.streamerId));
}
