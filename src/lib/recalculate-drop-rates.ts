import type { Card } from "@/types/database";

import { normalizeDropRate } from "@/lib/card-utils";
import { calculateDropRates } from "@/lib/rarity-weight-calculator";
import { logger } from "@/lib/logger.server";
// ---------------------------------------------------------------------------
// batch_update_card_drop_rates RPC は PlanetScale 接続だけを使う。import 時点で
// 接続を確立しないため、DB は実際のリクエスト実行時にのみ取得される。
// ---------------------------------------------------------------------------
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable } from "@/lib/db/schema";

/**
 * batch_update_card_drop_rates RPC の pg 直結エラーを PostgREST .rpc() の error と
 * 同じ「code + message」形状へ正規化するための最小型(#573)。postgres.js は
 * PostgrestError と異なりエラーを throw するため、両呼び出し元(本ファイルの
 * recalculateIfAutoMode と POST /api/cards/batch-update)の既存エラー分岐
 * (throw / handleDatabaseError への受け渡し)を両経路で共有するにはこの形への
 * 詰め替えが必要(gacha.ts GachaRpcDriverError と同じ設計)。
 */
interface BatchUpdateRpcDriverError {
  code?: string;
  message: string;
}

/**
 * batch_update_card_drop_rates RPC (migration 00011 で新設、00027 で
 * intra_rarity_weight 対応を追加。RETURNS JSONB) の pg 直結(postgres.js)実装 (#573)。
 *
 * recalculateIfAutoMode(本ファイル)と POST /api/cards/batch-update
 * (src/app/api/cards/batch-update/route.ts)の両方が同じ RPC を名前付き引数で
 * 呼ぶため、pg 経路のSQL文・エラー正規化をこの1関数に集約して重複を避ける
 * (この2箇所は移行前の旧 Supabase 実装の時点でも別々の .rpc() 呼び出しであり、
 * そちらは変更しない — 新設する pg 経路の実装だけをここに共通化する)。
 *
 * 名前付き引数 + 明示キャストの理由は gacha.ts executeGachaTransactionRpcPg の
 * doc コメントと同じ: 将来の引数追加・並び替えでの取り違え事故を防ぐため。
 * 値はすべて postgres.js のバインドパラメータとして送られるため SQL インジェク
 * ションは構造的に不可能。p_updates (JSONB) は JSON.stringify() で文字列化して
 * から ::jsonb キャストする(gacha.ts の doc コメントに明記された jsonb 引数の
 * 渡し方と同じ規約)。p_streamer_id は ::uuid キャストで型解決を固定する。
 *
 * jsonb 戻り値の JS オブジェクト化については gacha.ts executeGachaTransactionRpcPg
 * の doc コメント参照(postgres.js は fetch_types:false でも json/jsonb の
 * 組み込みパーサを常に登録している)。
 *
 * 冪等性判断(plpgsql根拠。migration 00027 が最新定義):
 *   UPDATE cards SET
 *     drop_rate = (u.value->>'drop_rate')::DECIMAL(5,4),
 *     intra_rarity_weight = COALESCE((u.value->>'intra_rarity_weight')::NUMERIC, cards.intra_rarity_weight),
 *     updated_at = NOW()
 *   FROM jsonb_array_elements(p_updates) AS u(value)
 *   WHERE cards.id = (u.value->>'id')::UUID AND cards.streamer_id = p_streamer_id;
 * 全 SET 句が「呼び出し時のペイロード値をそのまま代入」または「未指定なら
 * COALESCE で既存値を代入し直すだけ」の決定的な代入で構成されており、カウンタ
 * 加算や一度きりの状態遷移を一切含まない「同一値への UPDATE」に分類できる。
 * 1回目の実行が実際にはコミット済みで応答だけ接続断で失われた場合でも、同一
 * 引数での再実行は同じ行に同じ値を再代入するだけで収束先の状態は変わらない
 * (updated_at のタイムスタンプだけがずれるが、呼び出し元はこの値を検証しない。
 * pg 直結の他モジュールで許容されている「日付表現の差」と同種の副作用)。
 * よって idempotent: true として接続断リトライを許可する。
 *
 * 42883 (RPC未デプロイ)特有のフォールバック分岐は設けない: 呼び出し元2箇所とも
 * 既存 postgrest 実装が 42883 を特別扱いしていない(recalculateIfAutoMode は
 * rpcError をそのまま throw、POST /api/cards/batch-update は handleDatabaseError
 * に丸ごと渡すのみ)ため、既存に無い保護を追加しない(#573 実装規約)。
 */
export async function executeBatchUpdateCardDropRatesRpcPg(
  streamerId: string,
  updates: Array<Record<string, unknown>>
): Promise<{
  data: { updated_count?: number } | null;
  error: BatchUpdateRpcDriverError | null;
}> {
  try {
    const data = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ(リクエストスコープ破棄からの回復には
        // クライアント再取得が必要。src/lib/db/retry.ts 参照)
        const { sql } = await getDb();
        const rows = await sql<{ result: { updated_count?: number } | null }[]>`
          select batch_update_card_drop_rates(
            p_streamer_id => ${streamerId}::uuid,
            p_updates => ${JSON.stringify(updates)}::jsonb
          ) as result
        `;
        return rows[0]?.result ?? null;
      },
      "batch_update_card_drop_rates(pg)",
      { idempotent: true },
    );
    return { data, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown } | null)?.code;
    return {
      data: null,
      error: { code: typeof code === "string" ? code : undefined, message },
    };
  }
}

type RecalculationCard = Pick<
  Card,
  "id" | "rarity" | "is_active" | "intra_rarity_weight"
>;

/**
 * Issue #794/#803: 再計算対象も PlanetScale から取得する。
 *
 * 以前は更新RPCだけが pg 直結で、前後の SELECT は Supabase のままだったため、
 * cutover後に PlanetScale へ追加されたカードが再計算対象から漏れていた。
 * 読み書き混在処理は最初から最後まで同じ PlanetScale 接続先へ揃える。
 */
async function fetchActiveCardsForRecalculationPg(
  streamerId: string
): Promise<RecalculationCard[]> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          id: cardsTable.id,
          rarity: cardsTable.rarity,
          is_active: cardsTable.is_active,
          intra_rarity_weight: cardsTable.intra_rarity_weight,
        })
        .from(cardsTable)
        .where(
          and(
            eq(cardsTable.streamer_id, streamerId),
            eq(cardsTable.is_active, true)
          )
        );
    },
    "recalculateIfAutoMode: active cards(pg)",
    { idempotent: true }
  );

  // is_active=true で絞っているため、この処理内では nullable なDB型を
  // calculateDropRates が要求する boolean として安全に扱える。
  return rows as RecalculationCard[];
}

/**
 * Issue #794: pg更新後のカードも同じ PlanetScale 接続から取得する。
 * cards の全列は本番に実在することを実測で確認済みのため（Issue #834）、
 * 無指定 select をそのまま使う。
 */
async function fetchRecalculatedCardsPg(
  streamerId: string,
  updatedCardIds: string[]
): Promise<Card[]> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select()
        .from(cardsTable)
        .where(
          and(
            eq(cardsTable.streamer_id, streamerId),
            inArray(cardsTable.id, updatedCardIds)
          )
        );
    },
    "recalculateIfAutoMode: recalculated cards(pg)",
    { idempotent: true }
  );
  return normalizeDropRate(rows as unknown as Card[]);
}

/**
 * Recalculate active cards drop_rate when rarity auto mode is enabled.
 * Returns updated active cards, [] when no active cards exist, or null when auto mode is disabled.
 */
export async function recalculateIfAutoMode(
  streamerId: string,
  rarityWeights: Record<string, number> | null | undefined
): Promise<Card[] | null> {
  // null = 未設定, {} = 手動モード明示 → いずれも自動再計算スキップ
  if (!rarityWeights || Object.keys(rarityWeights).length === 0) {
    return null;
  }

  // #708: 再計算の読み書きを同じ PlanetScale 接続へ固定する。切替フラグを
  // 残すと停止済み Supabase へ片側だけ戻る余地が生じるため、入口から単一路線にする。
  const activeCards = await fetchActiveCardsForRecalculationPg(streamerId);

  const updates = calculateDropRates(activeCards, rarityWeights);
  if (updates.length === 0) {
    return [];
  }

  // drop_rateのみ更新。intra_rarity_weightはユーザーが設定した値をそのまま保持するため
  // RPCペイロードには含めない（calculateDropRatesで読み取り済み）
  const rpcPayload = updates.map((update) => ({
    id: update.id,
    drop_rate: update.dropRate,
  }));

  const { data: rpcResult, error: rpcError } =
    await executeBatchUpdateCardDropRatesRpcPg(streamerId, rpcPayload);

  if (rpcError) {
    throw rpcError;
  }

  // 並行操作（別タブでのカード削除等）により件数が一致しない場合がある
  // 部分更新は正常動作のため、throwせずに警告ログのみ出力
  const updatedCount = rpcResult?.updated_count ?? 0;
  if (updatedCount !== updates.length) {
    logger.warn(
      `[recalculateIfAutoMode] Count mismatch: expected ${updates.length}, got ${updatedCount} (concurrent modification likely)`
    );
  }

  const updatedCardIds = updates.map((update) => update.id);
  return fetchRecalculatedCardsPg(streamerId, updatedCardIds);
}
