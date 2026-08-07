/**
 * クエリパラメータ等の文字列を安全に整数へパースする共通ヘルパ。
 * issue #836: GET /api/cards 等で parseInt 直接使用により
 * "abc" → NaN、負値が PostgreSQL に渡り 500 ノイズを生む問題を防ぐ。
 * 呼び出し側で Math.min/Math.max による clamp と組み合わせる。
 *
 * @param value パース対象の文字列（クエリパラメータ等）。null ならデフォルト値
 * @param defaultValue パース不能・1 未満の値のフォールバック
 * @returns パース結果。パース不能または 1 未満の場合は defaultValue
 */
export function safeParseInt(value: string | null, defaultValue: number): number {
  if (value === null) return defaultValue
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < 1) return defaultValue
  return parsed
}
