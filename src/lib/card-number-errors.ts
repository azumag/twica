import { getErrorChain } from "@/lib/db/errors";

export const CARD_NUMBER_MESSAGES = {
  duplicate: "このカード番号はすでに別のカードで使われています。",
  invalid: "カード番号は1以上の整数で入力してください。",
} as const;

// cause チェーン対応 (2026-07 本番障害の恒久対応): この2関数は postgrest/pg
// 両経路の共用判定として使われる（src/app/api/cards/route.ts の insertCardPg
// が pg 直結の db.insert(...).returning() の catch にそのまま渡す）。Drizzle は
// postgres.js の PostgresError を DrizzleQueryError で1段ラップし、SQLSTATE・
// 実メッセージは cause 側にしか無いため、トップレベルの code/message/details
// だけを見ていると pg 経路でこのフォールバックが機能しない。getErrorChain で
// トップレベル→cause の各階層に同じ判定を適用する（生の postgres.js /
// PostgREST エラーはチェーンが1要素になるだけなので既存の後方互換は保たれる）。
//
// 階層ごとに独立判定する理由 (Fable厳格レビュー指摘・中4): 全階層のテキストを
// 連結してから判定すると、無関係な階層の文言（例: DrizzleQueryError.message =
// 実行された SQL 文そのもの。INSERT 対象列に "card_number" が含まれていれば
// 常にヒットする）に判定対象の語が偶然含まれているだけで誤検知しうる
// （cause が実際は unique_violation ではなく全く別の理由でも、SQL 文に
// "card_number" が写っているだけで isCardNumberConflictError が true になる
// 等）。各階層の自分自身の code/message/details だけで旧判定を適用し、
// どこか1階層でも満たせば true とする（cards-safe-columns.ts と同じ設計）。

export function isCardNumberConflictError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  return getErrorChain(error).some((layer) => {
    if (typeof layer !== "object" || layer === null) return false;
    const err = layer as { code?: unknown; message?: unknown; details?: unknown };
    if (err.code !== "23505") return false;

    const text = `${String(err.message || "")} ${String(err.details || "")}`;
    return text.includes("cards_streamer_card_number_unique") || text.includes("card_number");
  });
}

export function isMissingCardNumberColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  return getErrorChain(error).some((layer) => {
    if (typeof layer !== "object" || layer === null) return false;
    const err = layer as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    const text = [err.message, err.details, err.hint].map((value) => String(value || "")).join(" ");

    return text.includes("card_number") && (
      text.includes("schema cache") ||
      text.includes("column") ||
      err.code === "PGRST204"
    );
  });
}
