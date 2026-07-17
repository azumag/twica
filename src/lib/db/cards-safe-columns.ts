// -----------------------------------------------------------------------------
// cards テーブルの「本番未デプロイ8列」フォールバック用ヘルパー (#663 self-review fix)
//
// 背景: src/lib/db/schema.ts の cards テーブル定義には、本番 Supabase の実テーブル
// には存在しない8列（card_number, hp, atk, def, spd, skill_type, skill_name,
// skill_power）が含まれている(Issue #625で確認済みの既知ドリフト。マイグレーション
// 履歴上は適用済みだが実テーブルには列が無い)。card_number は #393/#548 以降、
// INSERT/UPDATE の入力値・ORDER BY 列としての欠落フォールバックが既に
// card-number-errors.ts / 各ルートに実装されているが、hp/atk/def/spd/skill_*
// (バトル機能用、未着手のカードバトル機能の残骸)は一度もフォールバック対象に
// なっていなかった。
//
// Drizzle の無指定 `.select()` / `.returning()` は PostgREST の `select("*")`
// （実在する列だけを動的に返す）と異なり、TypeScript スキーマ定義(schema.ts)に
// 基づく「静的な列リスト」を生成する。そのため本番でこれらの列を含む
// SELECT/RETURNING を発行すると `column "hp" does not exist` 等で必ず失敗する。
//
// 対応方針: 既存の「まず試す→列不足エラーを検知→列を除いて再試行」パターン
// (card-number-errors.ts 等)を、SELECT/RETURNING の出力列リストにも適用する。
// まず無指定(全列)を試み、失敗したらここで定義する明示列リスト
// (CARDS_SAFE_COLUMNS)で再試行する。preview 等、実際に8列が存在する環境では
// 無指定 select/returning がそのまま成功するため、明示列リストへは経路が
// 到達しない(= 全列を返す挙動を維持。postgrest 経路とのパリティを保つ)。
// -----------------------------------------------------------------------------

import { cards as cardsTable } from "@/lib/db/schema";
import { collectErrorSignals } from "@/lib/db/error-signals";

export const CARDS_MISSING_IN_PRODUCTION_COLUMNS = [
  "card_number",
  "hp",
  "atk",
  "def",
  "spd",
  "skill_type",
  "skill_name",
  "skill_power",
] as const;

export const CARDS_SAFE_COLUMNS = {
  id: cardsTable.id,
  streamer_id: cardsTable.streamer_id,
  name: cardsTable.name,
  description: cardsTable.description,
  image_url: cardsTable.image_url,
  rarity: cardsTable.rarity,
  rarity_order: cardsTable.rarity_order,
  drop_rate: cardsTable.drop_rate,
  intra_rarity_weight: cardsTable.intra_rarity_weight,
  max_issuance_count: cardsTable.max_issuance_count,
  collection_name: cardsTable.collection_name,
  is_active: cardsTable.is_active,
  created_at: cardsTable.created_at,
  updated_at: cardsTable.updated_at,
} as const;

export function isMissingCardsBattleColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const { codes, text } = collectErrorSignals(error);
  const looksLikeSchemaError =
    text.includes("schema cache") ||
    text.includes("column") ||
    codes.has("PGRST204") ||
    codes.has("42703");
  if (!looksLikeSchemaError) return false;

  return CARDS_MISSING_IN_PRODUCTION_COLUMNS.some((column) => text.includes(column));
}

export async function withCardsBattleColumnFallback<T>(
  attempt: (useSafeColumns: boolean) => Promise<T>
): Promise<T> {
  try {
    return await attempt(false);
  } catch (error) {
    if (!isMissingCardsBattleColumnError(error)) throw error;
    return attempt(true);
  }
}
