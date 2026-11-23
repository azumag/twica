// -----------------------------------------------------------------------------
// トレードの「交換対象の制限」(出品カードごとのホワイトリスト)の読み書き。
//
// 判定そのもの(出品・ボード・応諾・入札)は src/lib/trade.ts の
// wantedAllowedForOffered と 20261123000000_trade_wanted_restrictions.sql の RPC が
// 行う。このファイルは次の3つだけを担う(設計: tasks/plans/trade-wanted-restriction.md):
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

import { getDb } from "@/lib/db/client";
import { isPgMissingTableError } from "@/lib/db/errors";
import { withDbRetry } from "@/lib/db/retry";
import {
  cards as cardsTable,
  streamers as streamersTable,
  tradeWantedRestrictionItems as itemsTable,
  tradeWantedRestrictionRules as rulesTable,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger.server";

/** 1つのルール(出品カード1枚)に入れられる許可カードの上限。 */
export const TRADE_WANTED_RESTRICTION_MAX_ITEMS = 100;
/** 配信者1人が持てるルール(出品カード)数の上限。 */
export const TRADE_WANTED_RESTRICTION_MAX_RULES = 200;

export type TradeWantedRestrictionCard = {
  id: string;
  name: string;
  rarity: string;
  isActive: boolean;
};

export type TradeWantedRestrictionSettings = {
  /** 配信者の全カード(無効カードを含む。許可カードに残っている無効カードを外せるように)。 */
  cards: TradeWantedRestrictionCard[];
  /** 出品カード id → 許可カード id。許可0件のルールは空配列で残る。 */
  rules: Record<string, string[]>;
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
        const ruleRows = await db
          .select({
            offeredCardId: rulesTable.offered_card_id,
            wantedCardId: itemsTable.wanted_card_id,
          })
          .from(rulesTable)
          .innerJoin(cardsTable, eq(cardsTable.id, rulesTable.offered_card_id))
          .leftJoin(itemsTable, eq(itemsTable.offered_card_id, rulesTable.offered_card_id))
          .where(eq(cardsTable.streamer_id, streamerId));
        const rules: Record<string, string[]> = {};
        for (const row of ruleRows) {
          const allowed = (rules[row.offeredCardId] ??= []);
          if (row.wantedCardId) allowed.push(row.wantedCardId);
        }
        return {
          // is_active は nullable(DEFAULT true)。明示的な false だけを無効として扱う。
          cards: cards.map((card) => ({ ...card, isActive: card.isActive !== false })),
          rules,
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
       * CARD_NOT_FOUND: 出品カードまたは許可カードが、この配信者のカードではない/存在しない
       *   (他配信者のカードの存在は区別して返さない)。
       * TOO_MANY_RULES: 配信者あたりのルール数の上限。
       */
      code: "CARD_NOT_FOUND" | "TOO_MANY_RULES";
    };

/**
 * 出品カード `offeredCardId` のルールを、許可カード `allowedWantedCardIds` へ丸ごと置換する。
 * 空配列はルールの削除(= 制限なしに戻す)。入力の形(UUID・重複・上限・自己指定)は
 * 呼び出し側(API route)が検証済みであることを前提にする。
 *
 * 1トランザクション。最初に配信者行を FOR NO KEY UPDATE でロックして、同じ配信者の
 * 設定更新をすべて直列化する(並行する「DELETE → INSERT」が互いの行を見ずに許可カードの
 * 和集合を作る / 主キー重複で失敗する、ルール数の上限検査が競合でずれる、のを避ける)。
 * NO KEY UPDATE にするのは、cards などが streamers を FK 参照する INSERT(KEY SHARE)を
 * ブロックしないため。最終状態を明示する置換なので冪等(再試行可)。
 *
 * 許可カードは同一配信者のカードに限る。無効(is_active=false)でも保存を許す: 後から
 * 無効化されたカードを含む既存ルールを、再保存できなくしないため(実行時は応諾・入札側が
 * cardIsActive で落とす)。
 */
export async function replaceTradeWantedRestriction(input: {
  streamerId: string;
  offeredCardId: string;
  allowedWantedCardIds: string[];
}): Promise<ReplaceTradeWantedRestrictionResult> {
  const { streamerId, offeredCardId, allowedWantedCardIds } = input;
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
        const involved = [offeredCardId, ...wantedIds];
        const owned = await tx
          .select({ id: cardsTable.id })
          .from(cardsTable)
          .where(and(eq(cardsTable.streamer_id, streamerId), inArray(cardsTable.id, involved)));
        if (owned.length !== new Set(involved).size) {
          return { kind: "error", code: "CARD_NOT_FOUND" };
        }

        if (wantedIds.length === 0) {
          // 親を消すと許可カード(子)も ON DELETE CASCADE で消える。
          await tx.delete(rulesTable).where(eq(rulesTable.offered_card_id, offeredCardId));
          return { kind: "ok", ruleRemoved: true };
        }

        const [existing] = await tx
          .select({ id: rulesTable.offered_card_id })
          .from(rulesTable)
          .where(eq(rulesTable.offered_card_id, offeredCardId));
        if (existing) {
          await tx
            .update(rulesTable)
            .set({ updated_at: sql`now()` })
            .where(eq(rulesTable.offered_card_id, offeredCardId));
        } else {
          const [{ count }] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(rulesTable)
            .innerJoin(cardsTable, eq(cardsTable.id, rulesTable.offered_card_id))
            .where(eq(cardsTable.streamer_id, streamerId));
          if (count >= TRADE_WANTED_RESTRICTION_MAX_RULES) {
            return { kind: "error", code: "TOO_MANY_RULES" };
          }
          await tx.insert(rulesTable).values({ offered_card_id: offeredCardId });
        }
        await tx.delete(itemsTable).where(eq(itemsTable.offered_card_id, offeredCardId));
        await tx
          .insert(itemsTable)
          .values(wantedIds.map((wantedCardId) => ({ offered_card_id: offeredCardId, wanted_card_id: wantedCardId })));
        return { kind: "ok", ruleRemoved: false };
      });
    },
    "trade-wanted-restrictions:replace",
    { idempotent: true },
  );
}

/**
 * フォーム・入札候補の絞り込み用の許可表: 出品カード id → 選べる card id の配列。
 * ルールが無い出品カードはキー自体を持たない(= 制限なし)。ルールがあって、
 * 選択肢(`selectableCardIds`)との交差が空なら `[]`(= 指定できるカードが無い)。
 *
 * 配列を返す前に必ず `selectableCardIds` と交差させる。この値は RSC の props として
 * クライアントへ直列化されるため、閲覧者に公開されていないカードの id・件数を
 * 含めてはならない(selectableCardIds は listWantableCards など公開判定済みの集合)。
 *
 * `where` は対象のルールを選ぶ: 出品カードの id 群、または配信者(その配信者の全ルール)。
 * 取得に失敗した場合(migration 前など)は絞り込みなし(空表)に縮退する。UI 補助であり、
 * 権威は出品 API・応諾/入札 RPC なので、縮退しても制限を素通りする経路は生じない。
 */
export async function loadAllowedWantedByOffered(
  where: { offeredCardIds: string[] } | { streamerId: string },
  selectableCardIds: ReadonlySet<string>,
): Promise<Record<string, string[]>> {
  if ("offeredCardIds" in where && where.offeredCardIds.length === 0) return {};
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        const query = db
          .select({
            offeredCardId: rulesTable.offered_card_id,
            wantedCardId: itemsTable.wanted_card_id,
          })
          .from(rulesTable)
          .leftJoin(itemsTable, eq(itemsTable.offered_card_id, rulesTable.offered_card_id));
        if ("offeredCardIds" in where) {
          return query.where(inArray(rulesTable.offered_card_id, where.offeredCardIds));
        }
        return query
          .innerJoin(cardsTable, eq(cardsTable.id, rulesTable.offered_card_id))
          .where(eq(cardsTable.streamer_id, where.streamerId));
      },
      "trade-wanted-restrictions:allowed-map",
      { idempotent: true },
    );
    const allowedMap: Record<string, string[]> = {};
    for (const row of rows) {
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
