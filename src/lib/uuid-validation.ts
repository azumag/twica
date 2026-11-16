// TwiCa がURLやDB主キーとして発行するUUIDは、PostgreSQLの出力と同じ
// 8-4-4-4-12の標準構造へ統一されている。PostgreSQL自体は波括弧付きや
// ハイフン省略形も受理するが、アプリが生成しない表記まで外部入力で許可する
// 必要はないため、境界ではこの構造だけをallowlistする。既存overlay検証との
// 互換性を保つため判定では英字の大文字・小文字を区別せず、isCanonicalUuid は
// 入力の表記も変えない。DBのuuid出力は小文字なので、JSの文字列比較を行う
// 境界では normalizeCanonicalUuid で小文字へ揃える。
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

/**
 * 標準UUID構造なら小文字へ正規化して返し、そうでなければ null を返す。
 *
 * PostgreSQLの uuid 型は大文字小文字を区別しないが、DBが返す表記は常に小文字
 * で、JS側の文字列比較（同一カード判定、RPC結果の取引ID照合、auction_id の
 * 照合）は大文字と一致しない。トレードAPIでは成立後にRPC結果を検証するため、
 * ここで不一致になると移転済みの取引が500になる（#2061）。外部入力の境界で
 * この関数を通し、DBと同じ小文字表記へ揃えてからサービスへ渡す。
 *
 * 形式判定は isCanonicalUuid に委ねる。同関数が大文字を受理する既存挙動は
 * 変えない（overlay など他の呼び出し元との後方互換のため）。
 */
export function normalizeCanonicalUuid(value: string): string | null {
  return isCanonicalUuid(value) ? value.toLowerCase() : null
}
