// TwiCa がURLやDB主キーとして発行するUUIDは、PostgreSQLの出力と同じ
// 8-4-4-4-12の標準構造へ統一されている。PostgreSQL自体は波括弧付きや
// ハイフン省略形も受理するが、アプリが生成しない表記まで外部入力で許可する
// 必要はないため、境界ではこの構造だけをallowlistする。既存overlay検証との
// 互換性を保つため英字の大文字・小文字は区別せず、表記の小文字化は行わない。
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 値がTwiCaで使用する標準UUID構造かを判定する。
 *
 * UUIDのversion/variantまでは制限しない。既存データの生成元が変わっても、
 * 128bit UUIDとして正しい標準表記なら同じDB主キー境界を安全に通せるため。
 */
export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID_PATTERN.test(value)
}
