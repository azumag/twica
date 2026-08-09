// -----------------------------------------------------------------------------
// cards テーブルの「本番未デプロイ8列」フォールバック用ヘルパー (#663 self-review fix)
//
// 背景: src/lib/db/schema.ts の cards テーブル定義には、本番 DB の実テーブル
// には存在しない8列（card_number, hp, atk, def, spd, skill_type, skill_name,
// skill_power）が含まれている(Issue #625で確認済みの既知ドリフト。マイグレーション
// 履歴上は適用済みだが実テーブルには列が無い)。card_number は #393/#548 以降、
// INSERT/UPDATE の入力値・ORDER BY 列としての欠落フォールバックが既に
// card-number-errors.ts / 各ルートに実装されているが、hp/atk/def/spd/skill_*
// (バトル機能用、未着手のカードバトル機能の残骸)は一度もフォールバック対象に
// なっていなかった。
//
// Drizzle の無指定 `.select()` / `.returning()` は TypeScript スキーマ定義
// (schema.ts) に基づく静的な列リストを生成する。そのため本番でこれらの列を含む
// SELECT/RETURNING を発行すると `column "hp" does not exist` 等で必ず失敗する。
//
// 対応方針: 既存の「まず試す→列不足エラーを検知→列を除いて再試行」パターン
// (card-number-errors.ts 等)を、SELECT/RETURNING の出力列リストにも適用する。
// まず無指定(全列)を試み、失敗したらここで定義する明示列リスト
// (CARDS_SAFE_COLUMNS)で再試行する。preview 等、実際に8列が存在する環境では
// 無指定 select/returning がそのまま成功するため、明示列リストへは経路が
// 到達しない（全列を返す挙動を維持する）。
// -----------------------------------------------------------------------------

import { cards as cardsTable } from "@/lib/db/schema";
import { isPgMissingNamedColumnError } from "@/lib/db/errors";

/**
 * 本番 cards テーブルに実在しないことが確認済みの8列 (Issue #625,
 * scripts/verify-db-schema.js による実測)。card_number はカード番号採番用、
 * 残り7列は未着手のカードバトル機能用に schema.ts へ定義されているだけで、
 * 対応するマイグレーションが本番に適用されていない。
 */
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

/**
 * 上記8列を除いた cards テーブルの明示的な列オブジェクト。
 * Drizzle の `.select({ ... })` / `.returning({ ... })` にそのまま渡せる。
 *
 * rarity_order は GENERATED ALWAYS AS ... STORED の生成カラムで INSERT/UPDATE
 * 対象外だが、SELECT/RETURNING は可能かつ本番に実在するため含める
 * （生成列を含めて API の既存レスポンス形状を維持する）。
 */
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

// 注意（#899）: image_padding_color は意図的に CARDS_SAFE_COLUMNS に含めない。
// このリストは「8列欠落環境での最終フォールバック」に使われ、ここに含めると
// 欠落環境（image_padding_color も存在しない）でフォールバック自体が失敗する。
// PlanetScale 移行後は8列が存在し（issue #834 実測）このフォールバックは
// 発動しないため、実本番では全列 select に image_padding_color が含まれる。
// 本番の8列欠落が解消され、このフォールバックを撤去する（#834）際に、
// あわせて image_padding_color の扱いを見直すこと。

/**
 * 「cards テーブルの本番未デプロイ8列のいずれかが存在しない」ことによる
 * SELECT/RETURNING 失敗を検知する。SQLSTATE 42703 と対象列名を同じ
 * PostgresError 階層で確認し、8列全てへ適用する。
 *
 * pg (postgres.js) の RETURNING/SELECT は列リストをまとめて評価するため、
 * エラーメッセージには通常「最初に解決できなかった1列」のみが含まれる
 * (例: `column "card_number" of relation "cards" does not exist"`)。
 * 8列は本番で常にまとめて欠落している(Issue #625)ため、いずれか1列分の
 * エラーテキストを検知できれば、明示列リストへの再試行で残り7列も含めて
 * 解消される。
 *
 * cause チェーン対応 (2026-07 本番障害の恒久対応): Drizzle は postgres.js の
 * PostgresError を DrizzleQueryError で1段ラップするため、SQLSTATE (42703) と
 * 「column "card_number" ... does not exist」の実テキストは cause 側にしか
 * 無い。トップレベルの code/message/details/hint だけを見ていたため、本番で
 * このフォールバックが発動せず getActiveCardsForStreamer (pg) がカード一覧を
 * 空で返す障害になった。getErrorChain でトップレベル→cause の各階層を辿る。
 *
 * 階層ごとに独立判定する理由 (Fable厳格レビュー指摘・中4): 当初の実装は
 * 全階層の message/details/hint を1本のテキストへ連結してから判定していたが、
 * これだと無関係な階層の文言に判定対象の列名が偶然含まれているだけで誤検知
 * しうる。典型例: Drizzle の DrizzleQueryError.message は「実行された SQL 文
 * そのもの」であり、SELECT 対象列を並べた文字列には8列のどれかの列名が
 * 高確率で含まれる。一方 cause（本当の原因）は全く別の理由（接続断・権限
 * エラー等）かもしれない。これを連結すると「無関係な原因なのに8列欠落」と
 * 誤判定してしまう。共通 helper は SQLSTATE 42703 と対象列名を同じ階層に要求し、
 * 生の postgres.js エラーと Drizzle のラップ済みエラーを安全に扱う。
 */
export function isMissingCardsBattleColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, CARDS_MISSING_IN_PRODUCTION_COLUMNS);
}

/**
 * image_padding_color 列の欠落（migration 未適用の本番DB）を検知する（#899）。
 * INSERT/UPDATE にこの列が含まれると、列が未適用の環境では全体が失敗するため、
 * 列欠落時は該当フィールドを落として再試行する（余白情報だけが保存されない）。
 */
export function isMissingCardPaddingColorError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, ["image_padding_color"]);
}

/**
 * 「まず無指定/全列で試行 → 列欠落エラー検知 → CARDS_SAFE_COLUMNS で再試行」
 * パターンの共通化 (#685 self-review fix)。src/lib/dashboard-data.ts の7箇所
 * （getStreamerDataPg 等）で同一の try/catch/retry が反復していたため抽出した。
 *
 * attempt(useSafeColumns) は呼び出し側が useSafeColumns の値に応じてクエリの
 * 列指定（無指定 or CARDS_SAFE_COLUMNS 等への差し替え）を切り替える形で実装する。
 * isMissingCardsBattleColumnError に該当しないエラーはそのまま再送出し、
 * 呼び出し側の既存 catch（エラー時の外部挙動パリティ維持）に委ねる。
 */
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
