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
 * マイコレクション一覧 (/dashboard/collection) は getUserCards() の結果を
 * `card.streamer` でグルーピングしており、配信者（= コレクション）を
 * 「その配信者のカードを1枚以上 user_cards に持っている」と定義している。
 * トレードハブのコレクション別一覧も同じ定義でなければ、片方にだけ出る
 * 配信者や、反対に「持っていないのに出品だけ見える」状態が生まれる。
 *
 * このサブクエリがその定義の正本である。カードの is_active は条件にしない
 * （非アクティブになったカードでも、所持していればコレクションは表示される。
 * これはマイコレクション一覧のグルーピングと同じ）。
 *
 * SQL 側の IN 副問い合わせとして使える形にしてあるため、トレードの一覧
 * （出品・オークション）は viewer の所持配信者をこの1か所から参照する。
 * 同じ定義を TS 側で必要な画面は getCollectedStreamerIds() を使う。
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
 * 視聴者がカードを持っている配信者IDの集合。
 *
 * `streamerId` を渡すと、同じ定義のまま1配信者だけに絞る（展開 API の
 * 権限確認に使う）。展開 API は「持っていないコレクション」を 404 にする
 * 必要があるが、一覧クエリが0行だっただけでは「持っていない」のか
 * 「持っているが出品が無い」のか区別できないため、この関数で先に確かめる。
 *
 * 読み取り専用なので withDbRetry は idempotent: true。失敗時は呼び出し側が
 * 縮退を決められるよう例外をそのまま返す（ダッシュボードは getUserCards の
 * 結果へフォールバックし、API は 500 にする）。
 */
export async function getCollectedStreamerIds(
  twitchUserId: string,
  streamerId?: string,
): Promise<Set<string>> {
  const inCollected = sql<boolean>`${cardsTable.streamer_id} IN ${collectedStreamerIdsSubquery(twitchUserId)}`;
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .selectDistinct({ streamerId: cardsTable.streamer_id })
        .from(cardsTable)
        .where(
          streamerId
            ? and(inCollected, eq(cardsTable.streamer_id, streamerId))
            : inCollected,
        );
    },
    "collected-streamers:ids",
    { idempotent: true },
  );
  return new Set(rows.map((row) => row.streamerId));
}
