export const CARD_ISSUANCE_MESSAGES = {
  invalid: "発行可能枚数は1以上の整数、または空欄で入力してください",
  soldOut: "このカードは発行可能枚数に達しています",
  // R2 (PR #450 レビュー follow-up): execute_gacha_transaction RPC が未デプロイ
  // (42883)の間、executeGachaLegacy は発行枚数を FOR UPDATE で原子的に検証
  // できないため limited カードの抽選を拒否する。以前はこの拒否が soldOut と
  // 全く同じ文字列を使っていたため、eventsub route.ts の抑止フィルタ
  // (genuine soldOut は Sentry/Issue化しない)が本来アラートすべき「RPC未デプロイ」
  // という異常事態まで一緒に握りつぶしてしまっていた。ユーザー向け文言としては
  // 区別せず「一時的に抽選できません」で十分だが、内部的な error 文字列としては
  // soldOut と別の値にすることで、eventsub 側の抑止対象に含めず reportError を
  // 発火させ、本番で確実にアラートされるようにする。
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

export function isMissingCardIssuanceColumnError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const text = [
    err.message,
    err.details,
    err.hint,
  ].map((value) => String(value || "")).join(" ");

  return text.includes("max_issuance_count") && (
    text.includes("schema cache") ||
    text.includes("column") ||
    err.code === "PGRST204"
  );
}
