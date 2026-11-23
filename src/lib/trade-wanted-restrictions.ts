// -----------------------------------------------------------------------------
// トレードの「交換対象の制限」(配信者ごとの許可リスト)の読み書き。
//
// 配信者 S は「交換対象リスト」W(S) を1つだけ持つ。S のカードが出品カード
// (オークションでは出品カード)になるとき、求めるカード(入札カード)に指定できるのは
// W(S) のカードだけ。S にルールが無ければ制限なし。判定そのもの(出品・ボード・応諾・
// 入札)は src/lib/trade.ts の wantedAllowedForOffered と
// 20261124000000_trade_wanted_allowlist_per_streamer.sql の RPC が行う。このファイルは
// 次の3つだけを担う(設計: tasks/plans/trade-wanted-restriction.md v4):
//   1. 配信者の設定画面用の読み取り(getTradeWantedRestrictionSettings)
//   2. 設定 API 用の書き込み(replaceTradeWantedRestriction)
//   3. 出品フォーム・オークション入札の「選択肢の絞り込み」用の許可表
//      (loadAllowedWantedByOffered)。これは UI 補助で、権威は DB 側の判定。
//
// DB アクセスは Drizzle のクエリビルダー経由にする。本番の postgres.js は
// fetch_types:false(src/lib/db/client.ts)で、JS 配列を生のバインド値にすると
// 壊れた文字列になり、配列列・array_agg の結果もパースされない。そのため
// `inArray`(個別のバインド値へ展開される)と行単位の読み取り→JS での集約だけを使い、
// 配列バインドと array_agg は使わない。
//
// アプリ側にデプロイ窓のフォールバックは入れない(migration はアプリより先に適用される。
// docs/QA.md「migrationとアプリの適用順序」)。テーブルが無い間の読み取りは
// 呼び出し側で「設定欄を出さない」/「絞り込みなし」へ縮退させ、書き込みは 503 にする。
// -----------------------------------------------------------------------------

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDb } from "@/lib/db/client";
import { isPgMissingTableError } from "@/lib/db/errors";
import { withDbRetry } from "@/lib/db/retry";
import {
  cards as cardsTable,
  streamers as streamersTable,
  tradeAuctions as auctionsTable,
  tradeWantedAllowlistItems as itemsTable,
  tradeWantedAllowlistRules as rulesTable,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger.server";
import { viewerUserIdOf } from "@/lib/trade";
import { auctionPublicDetailCondition } from "@/lib/trade-auction";

// 上限は設定画面(クライアント)と共有するため、DB を読み込まない別モジュールに置く。
export { TRADE_WANTED_RESTRICTION_MAX_ITEMS } from "@/lib/trade-wanted-restriction-limits";

export type TradeWantedRestrictionCard = {
  id: string;
  name: string;
  rarity: string;
  isActive: boolean;
};

export type TradeWantedRestrictionSettings = {
  /** 配信者の全カード(無効カードを含む。許可カードに残っている無効カードを外せるように)。 */
  cards: TradeWantedRestrictionCard[];
  /**
   * 交換対象リスト W(S)。null = ルール無し(制限なし)。[] = ルールあり・許可0件
   * (誰も指定できない fail-closed。カードを全部削除したときに起こる)。
   */
  allowedWantedCardIds: string[] | null;
};

/**
 * 設定画面の初期値。取得に失敗した場合(migration 前でテーブルが無い、DB 障害)は null を
 * 返し、呼び出し側は設定欄だけを出さない(アカウントページ全体を落とさない)。
 */
export async function getTradeWantedRestrictionSettings(
  streamerId: string,
): Promise<TradeWantedRestrictionSettings | null> {
  try {
    return await withDbRetry(
      async () => {
        const { db } = await getDb();
        const cards = await db
          .select({
            id: cardsTable.id,
            name: cardsTable.name,
            rarity: cardsTable.rarity,
            isActive: cardsTable.is_active,
          })
          .from(cardsTable)
          .where(eq(cardsTable.streamer_id, streamerId))
          .orderBy(asc(cardsTable.rarity_order), asc(cardsTable.name), asc(cardsTable.id));
        // ルールの有無と許可カードを1文で読む(ルール行が無ければ0行 = null、
        // ルール行があり許可0件なら wantedCardId が NULL の1行 = [])。カード順で返す。
        // cards は外側の一覧でも使っているため、並び順用の JOIN は別名を付ける
        // (同じクエリ内で "cards" を2回参照すると PostgreSQL が table name specified
        // more than once で拒否する)。
        const orderedCard = alias(cardsTable, "allowlist_ordered_card");
        const ruleRows = await db
          .select({ wantedCardId: itemsTable.wanted_card_id })
          .from(rulesTable)
          .leftJoin(itemsTable, eq(itemsTable.streamer_id, rulesTable.streamer_id))
          .leftJoin(orderedCard, eq(orderedCard.id, itemsTable.wanted_card_id))
          .where(eq(rulesTable.streamer_id, streamerId))
          .orderBy(
            asc(orderedCard.rarity_order),
            asc(orderedCard.name),
            asc(orderedCard.id),
          );
        const allowedWantedCardIds = ruleRows.length === 0
          ? null
          : ruleRows.flatMap((row) => (row.wantedCardId ? [row.wantedCardId] : []));
        return {
          // is_active は nullable(DEFAULT true)。明示的な false だけを無効として扱う。
          cards: cards.map((card) => ({ ...card, isActive: card.isActive !== false })),
          allowedWantedCardIds,
        };
      },
      "trade-wanted-restrictions:settings",
      { idempotent: true },
    );
  } catch (error) {
    if (!isPgMissingTableError(error)) {
      logger.error("getTradeWantedRestrictionSettings failed", { error });
    }
    return null;
  }
}

export type ReplaceTradeWantedRestrictionResult =
  | { kind: "ok"; ruleRemoved: boolean }
  | {
      kind: "error";
      /**
       * CARD_NOT_FOUND: 許可カードのどれかが、この配信者のカードではない/存在しない
       *   (他配信者のカードの存在は区別して返さない)。
       */
      code: "CARD_NOT_FOUND";
    };

/**
 * 配信者 `streamerId` の交換対象リストを、許可カード `allowedWantedCardIds` へ丸ごと置換する。
 * 空配列はルールの削除(= 制限なしに戻す)。入力の形(UUID・重複・上限)は呼び出し側
 * (API route)が検証済みであることを前提にする。
 *
 * 1トランザクション。最初に配信者行を FOR NO KEY UPDATE でロックして、同じ配信者の
 * 設定更新をすべて直列化する(並行する「DELETE → INSERT」が互いの行を見ずに許可カードの
 * 和集合を作る / 主キー重複で失敗する、のを避ける)。NO KEY UPDATE にするのは、cards などが
 * streamers を FK 参照する INSERT(KEY SHARE)をブロックしないため。最終状態を明示する
 * 置換なので冪等(再試行可)。
 *
 * 許可カードは同一配信者のカードに限る。無効(is_active=false)でも保存を許す: 後から
 * 無効化されたカードを含む既存ルールを、再保存できなくしないため(実行時は応諾・入札側が
 * cardIsActive で落とす)。出品カード自身を許可に入れることも許す(リストは出品カードに
 * 依存しない。「自分自身を求むにして出品」は createTradeOffer の TRADE_SAME_CARD が
 * 従来どおり止める)。
 */
export async function replaceTradeWantedRestriction(input: {
  streamerId: string;
  allowedWantedCardIds: string[];
}): Promise<ReplaceTradeWantedRestrictionResult> {
  const { streamerId, allowedWantedCardIds } = input;
  return withDbRetry(
    async () => {
      const { db } = await getDb();
      return db.transaction(async (tx): Promise<ReplaceTradeWantedRestrictionResult> => {
        await tx
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.id, streamerId))
          .for("no key update");

        const wantedIds = [...new Set(allowedWantedCardIds)];

        if (wantedIds.length === 0) {
          // 親を消すと許可カード(子)も ON DELETE CASCADE で消える。
          await tx.delete(rulesTable).where(eq(rulesTable.streamer_id, streamerId));
          return { kind: "ok", ruleRemoved: true };
        }

        const owned = await tx
          .select({ id: cardsTable.id })
          .from(cardsTable)
          .where(and(eq(cardsTable.streamer_id, streamerId), inArray(cardsTable.id, wantedIds)));
        if (owned.length !== wantedIds.length) {
          return { kind: "error", code: "CARD_NOT_FOUND" };
        }

        const [existing] = await tx
          .select({ id: rulesTable.streamer_id })
          .from(rulesTable)
          .where(eq(rulesTable.streamer_id, streamerId));
        if (existing) {
          await tx
            .update(rulesTable)
            .set({ updated_at: sql`now()` })
            .where(eq(rulesTable.streamer_id, streamerId));
        } else {
          await tx.insert(rulesTable).values({ streamer_id: streamerId });
        }
        await tx.delete(itemsTable).where(eq(itemsTable.streamer_id, streamerId));
        await tx
          .insert(itemsTable)
          .values(wantedIds.map((wantedCardId) => ({ streamer_id: streamerId, wanted_card_id: wantedCardId })));
        return { kind: "ok", ruleRemoved: false };
      });
    },
    "trade-wanted-restrictions:replace",
    { idempotent: true },
  );
}

/**
 * 出品フォームの絞り込み用の許可表: 出品カード id → 選べる card id の配列。
 * ルールが無い配信者の出品カードはキー自体を持たない(= 制限なし)。ルールがあって、
 * 選択肢(`selectableCardIds`)との交差が空なら `[]`(= 指定できるカードが無い)。
 *
 * ルールは配信者単位だが、クライアントは出品カードで引く既存の形(キー = 出品カード id)を
 * 維持する。同じ配信者の出品カードには同じリストが返る。
 *
 * この値は RSC の props としてクライアントへ直列化されるため、閲覧者に公開されて
 * いないカードの id・ルールの件数を、キーにも値にも含めてはならない:
 *   - 値(許可カード)は必ず `selectableCardIds` と交差させる(listWantableCards など
 *     公開判定済みの集合)。
 *   - キーは、呼び出し側が閲覧者の所持コピーから選んだ出品カード(`offeredCardIds`)だけ。
 *     配信者の全ルールを読む形は作らない(無効・未公開カードの id とルール件数が載る)。
 *
 * 取得に失敗した場合(migration 前など)は絞り込みなし(空表)に縮退する。UI 補助であり、
 * 権威は出品 API・応諾/入札 RPC なので、縮退しても制限を素通りする経路は生じない。
 */
export async function loadAllowedWantedByOffered(
  offeredCardIds: string[],
  selectableCardIds: ReadonlySet<string>,
): Promise<Record<string, string[]>> {
  if (offeredCardIds.length === 0) return {};
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            offeredCardId: cardsTable.id,
            ruleStreamerId: rulesTable.streamer_id,
            wantedCardId: itemsTable.wanted_card_id,
          })
          .from(cardsTable)
          .leftJoin(rulesTable, eq(rulesTable.streamer_id, cardsTable.streamer_id))
          .leftJoin(itemsTable, eq(itemsTable.streamer_id, rulesTable.streamer_id))
          .where(inArray(cardsTable.id, offeredCardIds));
      },
      "trade-wanted-restrictions:allowed-map",
      { idempotent: true },
    );
    const allowedMap: Record<string, string[]> = {};
    for (const row of rows) {
      // ルールの無い配信者はキーを作らない(= 制限なし)。ルールがあり許可0件なら、
      // 子の LEFT JOIN が NULL の1行だけになるので [] のキーができる。
      if (!row.ruleStreamerId) continue;
      const allowed = (allowedMap[row.offeredCardId] ??= []);
      if (row.wantedCardId && selectableCardIds.has(row.wantedCardId)) allowed.push(row.wantedCardId);
    }
    return allowedMap;
  } catch (error) {
    if (!isPgMissingTableError(error)) {
      logger.error("loadAllowedWantedByOffered failed", { error });
    }
    return {};
  }
}

/**
 * オークション詳細の入札フォーム用の許可表(`loadAllowedWantedByOffered` と同じ形)。
 * 詳細ページのパスは入札に使うカードのチャネルで、クロスチャネルでは出品カードの
 * チャネルと異なる。そのため配信者単位ではなく、**その1つのオークションの出品カード**
 * から配信者を引き、そのリストだけを読む(出品カードのチャネルのルールを見落とすと、
 * 入札フォームで選べるカードがすべて入札時に拒否される)。
 *
 * 対象は、詳細 API が公開として返すオークション(`auctionPublicDetailCondition`: 受付中・
 * カードを拘束している・有効な出品カード・トレード有効・出品カードが閲覧者に見える)に
 * 限る。詳細が 404 になるオークション(トレード停止後など)について、保存したリンクから
 * 制限の有無や非公開カードの id を引き出せないようにするため。条件は詳細と同じ関数を
 * 共有する。見えない/存在しないオークションは空表。参加者(売り手・入札者)にだけ見える
 * 状態のオークションも空表になるが、その状態では新しい入札ができない(RPC も拒否する)。
 * クロスチャネルで制限付きのとき、入札側のカードは許可集合(出品側配信者のカード)に
 * 入らないので、結果は `[出品カード id]: []`(= 入札できるカードが無い)になり、RPC と一致する。
 */
export async function loadAllowedBidCardsForAuction(
  auctionId: string,
  viewerTwitchUserId: string,
  selectableCardIds: ReadonlySet<string>,
): Promise<Record<string, string[]>> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ offeredCardId: auctionsTable.offered_card_id })
          .from(auctionsTable)
          .where(
            and(
              eq(auctionsTable.id, auctionId),
              auctionPublicDetailCondition(viewerUserIdOf(viewerTwitchUserId)),
            ),
          )
          .limit(1);
      },
      "trade-wanted-restrictions:auction-offered-card",
      { idempotent: true },
    );
    const offeredCardId = rows[0]?.offeredCardId;
    if (!offeredCardId) return {};
    return await loadAllowedWantedByOffered([offeredCardId], selectableCardIds);
  } catch (error) {
    if (!isPgMissingTableError(error)) {
      logger.error("loadAllowedBidCardsForAuction failed", { error });
    }
    return {};
  }
}
