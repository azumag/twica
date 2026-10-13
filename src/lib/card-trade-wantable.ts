// -----------------------------------------------------------------------------
// cards.trade_wantable（#1790, 20261014100000_card_trade_wantable.sql）の
// カード管理側ヘルパー。
//
// trade_wantable = トレードの「求めるカード」に指定できるか（既定 true）。
// 配信者がカード管理画面のカード編集フォームで切り替える。トレード側の判定
// （出品拒否・ボード非表示・応諾拒否）は src/lib/trade.ts と accept_trade_offer。
//
// 列は cards 本体の Drizzle 定義ではなく schema.ts の cardTradeSettings にある
// （理由は schema.ts のコメント参照）。そのため getStreamerData / GET /api/cards /
// PUT /api/cards/[id] の既存の無指定 select・returning はこの列を返さず、
// ここで別に読み書きしてカード行へ合成する。
//
// デプロイ窓（migration 未適用、issue #788）では列が無く 42703 になる:
//   - 読み取り: 全カード指定可として扱う（migration 前は実際に全カードが指定可で、
//     列の既定値とも一致するため近似ではなく正確）。
//   - 書き込み: 保存できないので "column_missing" を返し、呼び出し側は
//     他フィールドの更新を妨げずに「保存できなかった」ことだけを応答に載せる
//     （collectionNameSkippedDeployWindow と同じ扱い）。
// -----------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { isPgMissingNamedColumnError } from "@/lib/db/errors";
import { withDbRetry } from "@/lib/db/retry";
import { cardTradeSettings } from "@/lib/db/schema";

export function isMissingCardTradeWantableColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, ["trade_wantable"]);
}

/**
 * 配信者のカードのうち「求めるカードに指定できない」ものの id 一覧。
 *
 * 全カードの値ではなく false の id だけを返すのは、既定値 true のカードが
 * 大多数で、結果を小さく保てるため（カード管理画面は最大1000枚を一度に読む）。
 * streamer_id で絞るので idx_cards_streamer_id（cards の既存索引）で引ける。
 */
export async function listNonWantableCardIds(streamerId: string): Promise<Set<string>> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: cardTradeSettings.id })
          .from(cardTradeSettings)
          .where(
            and(
              eq(cardTradeSettings.streamer_id, streamerId),
              eq(cardTradeSettings.trade_wantable, false),
            ),
          );
      },
      "cards:trade-wantable-list",
      { idempotent: true },
    );
    return new Set(rows.map((row) => row.id));
  } catch (error) {
    // デプロイ窓: 列が無い = 全カード指定可（ファイル冒頭参照）。
    if (isMissingCardTradeWantableColumnError(error)) return new Set();
    throw error;
  }
}

/**
 * カード行に trade_wantable を合成する。既存の行オブジェクトは変更せず、
 * 新しいオブジェクトを返す（unstable_cache の値や React の state を
 * 破壊的に書き換えないため）。
 */
export async function withCardTradeWantable<T extends { id: string }>(
  streamerId: string,
  cards: T[],
): Promise<Array<T & { trade_wantable: boolean }>> {
  if (cards.length === 0) return [];
  const nonWantable = await listNonWantableCardIds(streamerId);
  return cards.map((card) => ({ ...card, trade_wantable: !nonWantable.has(card.id) }));
}

/**
 * trade_wantable を明示的な最終値で更新する。所有者の認可は呼び出し側
 * （PUT /api/cards/[id] の所有権確認）が済ませている前提。
 *
 * 戻り値:
 *   - { trade_wantable }: 更新後の値
 *   - null: 対象行なし（並行削除など）
 *   - "column_missing": デプロイ窓で列が無く保存できなかった
 *
 * 明示的な最終値を書く UPDATE なので冪等（リトライ可）。
 */
export async function updateCardTradeWantable(
  cardId: string,
  tradeWantable: boolean,
): Promise<{ trade_wantable: boolean } | null | "column_missing"> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .update(cardTradeSettings)
          .set({ trade_wantable: tradeWantable })
          .where(eq(cardTradeSettings.id, cardId))
          .returning({ trade_wantable: cardTradeSettings.trade_wantable });
      },
      "Cards API PUT: update trade_wantable",
      { idempotent: true },
    );
    return rows[0] ?? null;
  } catch (error) {
    if (isMissingCardTradeWantableColumnError(error)) return "column_missing";
    throw error;
  }
}
