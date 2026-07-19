/**
 * DB 接続先切替フラグ (#693, #664/#568 Phase 2)
 *
 * Supabase → PlanetScale 段階移行の Phase 2 として、pg 直結経路が実際に
 * 接続する「先」（Hyperdrive binding / connection string）を DB_TARGET で
 * 明示的に切り替えられるようにする。
 *
 * src/lib/db/flags.ts の DB_DRIVER（'postgrest' | 'pg-read' | 'pg'）とは責務が
 * 異なる: DB_DRIVER は「どうやって繋ぐか」（PostgREST 経由 or pg 直結）、
 * DB_TARGET は「どこに繋ぐか」（Supabase or PlanetScale）。DB_DRIVER=pg かつ
 * DB_TARGET 未設定でも、今までどおり Supabase 向け Hyperdrive/DATABASE_URL に
 * 到達する（本モジュールが存在するだけでは既存の接続先解決に一切影響しない）。
 *
 * getDbDriverMode() と同じ理由で、process.env は「呼び出しのたびに」読み・
 * trim する（モジュールトップの const にキャッシュしない）。OpenNext
 * (Cloudflare Workers) は env を populateProcessEnv でランタイムに注入するため、
 * モジュール評価時点ではまだ確定していないことがある（flags.ts のコメント参照）。
 *
 * 未設定・不正値は安全側の 'supabase'（現行の唯一の本番接続先）に倒す。
 * 誤字・タイポで PlanetScale 側へ黙って倒れる方が、本番障害としてはるかに
 * 危険なため（fail-open ではなく fail-safe を優先する設計）。
 */

export type DbTarget = 'supabase' | 'planetscale'

export function getDbTarget(): DbTarget {
  const raw = process.env.DB_TARGET?.trim()
  return raw === 'planetscale' ? 'planetscale' : 'supabase'
}
