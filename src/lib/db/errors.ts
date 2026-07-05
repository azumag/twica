/**
 * pg ドライバ用エラー判定ヘルパー (#570)
 *
 * 目的: 既存コードには PostgREST のエラーコード判定（PGRST204「列が見つからない」等を
 * 検知して、コードとマイグレーションのデプロイ順ズレの間だけ旧クエリへフォールバック
 * する「デプロイ窓フォールバック」）が各所にある。それに対応する pg ドライバ
 * (postgres.js) 版の判定ヘルパー。移行済みモジュールが列/関数のデプロイ窓
 * フォールバックを維持するために使う。
 *
 * postgres.js が throw するエラーは `code` プロパティに PostgreSQL の SQLSTATE
 * （5文字の文字列）を持つ。呼び出し元が catch した値は unknown なので、
 * ここでは型ガードで安全に判定する（null / undefined / 文字列などを食わせても
 * 例外を出さず false を返す）。
 */

/**
 * unknown なエラー値から SQLSTATE 文字列（err.code）を安全に取り出す。
 * postgres.js の PostgresError は code に SQLSTATE を持つが、接続系エラーは
 * 'CONNECTION_CLOSED' のような非 SQLSTATE 文字列を持つため、呼び出し側の
 * 判定関数が期待値と厳密比較することで自然に除外される。
 */
function getSqlState(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) {
    return null
  }
  const code = (e as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * SQLSTATE 42703 undefined_column: 列が存在しない。
 * PostgREST の PGRST204 に相当（列追加マイグレーション前のコードデプロイ窓で発生）。
 */
export function isPgMissingColumnError(e: unknown): boolean {
  return getSqlState(e) === '42703'
}

/**
 * SQLSTATE 42883 undefined_function: 関数が存在しない。
 * RPC（DB 関数）追加マイグレーション前のデプロイ窓で発生。
 */
export function isPgFunctionNotFoundError(e: unknown): boolean {
  return getSqlState(e) === '42883'
}

/**
 * SQLSTATE 42P01 undefined_table: テーブルが存在しない。
 * テーブル追加マイグレーション前のデプロイ窓で発生。
 */
export function isPgMissingTableError(e: unknown): boolean {
  return getSqlState(e) === '42P01'
}
