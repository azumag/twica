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
  tradeAuctions as auctionsTable,
  tradeWantedRestrictionItems as itemsTable,
  tradeWantedRestrictionRules as rulesTable,
} from "@/lib/db/schema";
import { logger } from "@/lib/logger.server";
import { cardIsActive, cardVisibleTo, viewerUserIdOf } from "@/lib/trade";

// 上限は設定画面(クライアント)と共有するため、DB を読み込まない別モジュールに置く。
export {
  TRADE_WANTED_RESTRICTION_MAX_ITEMS,
  TRADE_WANTED_RESTRICTION_MAX_RULES,
} from "@/lib/trade-wanted-restriction-limits";
import { TRADE_WANTED_RESTRICTION_MAX_RULES } from "@/lib/trade-wanted-restriction-limits";

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
 * 出品フォームの絞り込み用の許可表: 出品カード id → 選べる card id の配列。
 * ルールが無い出品カードはキー自体を持たない(= 制限なし)。ルールがあって、
 * 選択肢(`selectableCardIds`)との交差が空なら `[]`(= 指定できるカードが無い)。
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
            offeredCardId: rulesTable.offered_card_id,
            wantedCardId: itemsTable.wanted_card_id,
          })
          .from(rulesTable)
          .leftJoin(itemsTable, eq(itemsTable.offered_card_id, rulesTable.offered_card_id))
          .where(inArray(rulesTable.offered_card_id, offeredCardIds));
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

/**
 * オークション詳細の入札フォーム用の許可表(`loadAllowedWantedByOffered` と同じ形)。
 * 詳細ページのパスは入札に使うカードのチャネルで、クロスチャネルでは出品カードの
 * チャネルと異なる。そのため配信者単位ではなく、**その1つのオークションの出品カード**の
 * ルールだけを読む(出品カードのチャネルのルールを見落とすと、入札フォームで選べる
 * カードがすべて入札時に拒否される)。
 *
 * 出品カードは、閲覧者に公開されている有効なカード(オークションの一覧・詳細と同じ
 * `cardVisibleTo` + `cardIsActive`)に限る。URL の auctionId から他人の非公開カードの
 * id・ルールを引き出せないようにするため。見えない/存在しないオークションは空表。
 * クロスチャネルで制限付きのとき、入札側のカードは許可集合(出品側チャネルのカード)に
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
              cardIsActive(auctionsTable.offered_card_id),
              cardVisibleTo(auctionsTable.offered_card_id, viewerUserIdOf(viewerTwitchUserId)),
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
