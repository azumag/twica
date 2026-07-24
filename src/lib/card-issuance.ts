import { isPgMissingNamedColumnError } from "@/lib/db/errors";

export const CARD_ISSUANCE_MESSAGES = {
  invalid: "発行可能枚数は1以上の整数、または空欄で入力してください",
  soldOut: "このカードは発行可能枚数に達しています",
  // execute_gacha_transaction RPC が未配備（42883）の場合は、上限を原子的に検証
  // できないため抽選をfail-closedにする。通常のsold-outと別文言にすることで、
  // EventSubの既知sold-out抑止に巻き込まず、deployment errorを必ず通知する。
  limitUnavailable: "上限付きカードは現在一時的に抽選できません",
} as const;

// R4 (PR #450 レビュー follow-up): max_issuance_count は DB 側で 4バイト
// PostgreSQL INTEGER 列(cards.max_issuance_count, migration 00067)として
// 保存されるため、その最大値 2147483647 を超える値を INSERT/UPDATE すると
// PostgreSQL は "22003 numeric_value_out_of_range" を返し、これがどこにも
// フレンドリーにハンドリングされないまま opaque な 500 エラーとして
// ユーザーに見えてしまう。ここで先にアプリ層の「製品として現実的な上限」で
// 弾き、CARD_ISSUANCE_MESSAGES.invalid の分かりやすいエラーメッセージへ
// 誘導する。
//
// MAX_ISSUANCE_COUNT_CAP = 1,000,000 の根拠:
// - どんな配信者の運用でも現実的にありえない発行枚数(1カードにつき100万枚
//   発行するガチャ運用は存在しない)を十分に超えており、正当な入力を
//   誤って弾くリスクはない。
// - PostgreSQL INTEGER の最大値(2,147,483,647)よりも十分小さく、桁あふれの
//   危険域から離れた安全マージンを持つ(将来 intra_rarity_weight 計算等で
//   この値を使った乗算をしても INTEGER/DOUBLE PRECISION の範囲を超えない)。
// UI(CardManager)からも同じ上限値を参照する(input[type=number] の max 属性)ため
// export する。サーバー側バリデーションとクライアント側入力制限を単一の値で
// 一致させ、値のドリフトを防ぐ。
export const MAX_ISSUANCE_COUNT_CAP = 1_000_000;

export function parseCardIssuanceLimit(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_ISSUANCE_COUNT_CAP
  ) {
    return "invalid";
  }
  return value;
}

// cause チェーン対応 (2026-07 本番障害の恒久対応): pg 直結の
// insert/returning catch から Drizzle にラップされたエラーがそのまま渡される。
// isPgMissingNamedColumnError が各階層で SQLSTATE と列名を同時に確認する。
//
// 階層ごとに独立判定する理由 (Fable厳格レビュー指摘・中4、詳細は
// card-number-errors.ts のコメント参照): 全階層のテキストを連結してから判定
// すると、無関係な階層の文言（SQL 文そのもの等）に "max_issuance_count" が
// 偶然含まれているだけで誤検知しうる。各階層の自分自身の情報だけで旧判定を
// 適用し、どこか1階層でも満たせば true とする。
export function isMissingCardIssuanceColumnError(error: unknown): boolean {
  return isPgMissingNamedColumnError(error, ["max_issuance_count"]);
}

// Issue #542: 配信者がCardManagerで「あと何枚発行できるか」を一目で把握できる
// よう、上限付きカードの発行済み枚数から売り切れ/残りわずかを判定する。
// 閾値(10%)はIssue本文の受け入れ条件「残り10%以下のカードに警告表示」に合わせた。
// Determines sold-out / low-remaining state for a limited-issuance card so
// CardManager can surface it. Threshold (10%) matches the issue's acceptance
// criteria ("残り10%以下のカードに警告表示がある").
export const LOW_REMAINING_THRESHOLD_RATIO = 0.1;

export interface IssuanceInfo {
  // 発行可能枚数の上限（呼び出し元がnull/undefinedを弾いた後の非null値）
  max: number;
  // 現在の発行済み枚数
  issued: number;
  // 上限に到達済みか（issued >= max）
  soldOut: boolean;
  // 残り枚数が上限の10%以下か（soldOutの場合はfalse。売り切れ表示と警告表示を
  // 同時に出さないための排他制御）
  lowRemaining: boolean;
}

/**
 * カードの発行状況（売り切れ/残りわずか）を判定する。
 * max_issuance_count が null/undefined（無制限カード）の場合は null を返し、
 * 呼び出し元（CardList/CardManagerのグリッド表示）で枚数表示自体を出さない
 * ようにする。
 *
 * Computes issuance status (sold out / low remaining) for a card.
 * Returns null for unlimited cards (max_issuance_count is null/undefined) so
 * callers (CardList / CardManager thumbnail grid) skip rendering the count
 * entirely.
 */
export function getIssuanceInfo(
  maxIssuanceCount: number | null | undefined,
  issuedCount: number | null | undefined
): IssuanceInfo | null {
  if (maxIssuanceCount === null || maxIssuanceCount === undefined) return null;

  const issued = issuedCount ?? 0;
  const soldOut = issued >= maxIssuanceCount;
  const lowRemaining =
    !soldOut &&
    maxIssuanceCount > 0 &&
    (maxIssuanceCount - issued) / maxIssuanceCount <= LOW_REMAINING_THRESHOLD_RATIO;

  return { max: maxIssuanceCount, issued, soldOut, lowRemaining };
}
