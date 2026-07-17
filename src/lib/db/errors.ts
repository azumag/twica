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
 * cause チェーンを辿る際の最大階層数。実際に必要な深さは通常 1
 * （Drizzle が postgres.js のエラーを1段ラップする）だが、将来のラップ追加や
 * 循環参照から呼び出し元を守るための安全弁として上限を設ける。
 */
const MAX_CAUSE_CHAIN_DEPTH = 5

/**
 * エラー値本体とその `cause` チェーンを浅い順（自身 → cause → cause.cause → …）
 * に配列として返す共通ヘルパー (#570/#685 本番障害の恒久対応)。
 *
 * 背景: Drizzle は postgres.js が throw する PostgresError を
 * `DrizzleQueryError extends Error { query, params, cause }` の形で1段ラップ
 * する（cause が元の PostgresError で、SQLSTATE・詳細メッセージはここにしか
 * 無い）。本ファイル・cards-safe-columns.ts・card-number-errors.ts・
 * card-issuance.ts・collections/collection-existence.ts の判定関数は、いずれも
 * トップレベルの `code`/`message`/`details`/`hint` だけを見ていたため、
 * ラップされた本番エラー（SQLSTATE 42703 の cards.card_number 列欠落）を
 * 検知できず、#685 で実装したはずのデプロイ窓フォールバックが発動しなかった
 * （2026-07 本番障害）。以後はこのヘルパーで両階層を辿ってから判定する。
 *
 * 生の postgres.js エラー（ラップなし）を渡した場合はチェーンが `[error]` の
 * 1要素になるだけなので、既存の「トップレベルのみを見る」呼び出し元との
 * 後方互換は自動的に保たれる。循環参照・同一オブジェクトの再訪は安全にスキップする。
 */
export function getErrorChain(error: unknown, maxDepth: number = MAX_CAUSE_CHAIN_DEPTH): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  let current = error

  for (let depth = 0; depth <= maxDepth; depth++) {
    if (current === null || current === undefined) break
    if (typeof current === 'object') {
      if (seen.has(current)) break // 循環参照ガード
      seen.add(current)
    }
    chain.push(current)
    if (typeof current !== 'object') break // プリミティブは cause を持たないため打ち切り
    current = (current as { cause?: unknown }).cause
  }

  return chain
}

/**
 * unknown なエラー値から SQLSTATE 文字列（err.code）を安全に取り出す。
 * postgres.js の PostgresError は code に SQLSTATE を持つが、接続系エラーは
 * 'CONNECTION_CLOSED' のような非 SQLSTATE 文字列を持つため、呼び出し側の
 * 判定関数が期待値と厳密比較することで自然に除外される。
 *
 * cause チェーン対応: Drizzle にラップされたエラーは code がトップレベルに
 * 無く cause 側にあるため、getErrorChain でチェーンを辿って最初に見つかった
 * 文字列 code を返す（トップレベル優先、無ければ cause 階層を見る）。
 *
 * export する理由 (Fable厳格レビュー指摘・2026-07): このファイル内の
 * isPgXxxError 群だけでなく、pg 直結の catch ブロックでトップレベルの
 * `(error as { code?: unknown })?.code` だけを見て 23505/エラーコード判定を
 * 行っていた箇所（gacha.ts の normalizePgReadError、
 * storage-bonus/vote-campaign/route.ts、streamer/additional-rewards/route.ts の
 * classifyError、db/retry.ts のログ出力）が同種のバグを抱えていたため、
 * 同じロジックを複製せずここへ集約する。
 */
export function getSqlState(e: unknown): string | null {
  for (const layer of getErrorChain(e)) {
    if (typeof layer !== 'object' || layer === null) continue
    const code = (layer as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
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

/**
 * SQLSTATE 23505 unique_violation: 一意制約違反。
 * PostgREST 経路の { error: { code: '23505' } } 判定に相当
 * （dashboard-data.ts の insertCompletionRecord 等、重複挿入を無視する
 * 既存パターンを pg 直結でも再現するために使う）。
 */
export function isPgUniqueViolationError(e: unknown): boolean {
  return getSqlState(e) === '23505'
}
