import { createClient, SupabaseClient } from '@supabase/supabase-js'

/**
 * Supabase環境変数を取得・バリデーションする共通ヘルパー
 * 環境変数に改行や空白が混入する場合があるため（Cloudflareダッシュボードでのペースト時など）
 * JWTには空白文字が含まれないため、すべての空白・改行を除去する
 */
function getSupabaseCredentials(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/\s/g, '')

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables')
  }

  return { url, key }
}

/**
 * Singleton Supabase admin client
 * Creating a new client on every request is expensive and causes latency.
 * This singleton pattern reuses the same client instance across requests.
 *
 * シングルトンのSupabase管理クライアント
 * リクエストごとに新しいクライアントを作成すると高コストで遅延の原因になる。
 * このシングルトンパターンでリクエスト間でクライアントインスタンスを再利用する。
 */
let supabaseAdmin: SupabaseClient | null = null

export function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdmin) {
    return supabaseAdmin
  }

  const { url, key } = getSupabaseCredentials()
  supabaseAdmin = createClient(url, key)
  return supabaseAdmin
}

/**
 * Singleton Supabase admin client with cache disabled (no-store fetch)
 * Reuses the same client instance to avoid redundant createClient() CPU cost.
 * The no-store fetch option ensures fresh data on every query.
 *
 * キャッシュ無効（no-store fetch）のシングルトンSupabase管理クライアント
 * createClient() のCPU負荷を避けるため同一インスタンスを再利用する。
 * no-store fetchオプションにより毎回最新データを取得する。
 */
let supabaseAdminNoCache: SupabaseClient | null = null

export function getSupabaseAdminNoCache(): SupabaseClient {
  if (supabaseAdminNoCache) {
    return supabaseAdminNoCache
  }

  const { url, key } = getSupabaseCredentials()
  supabaseAdminNoCache = createClient(url, key, {
    global: {
      fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }),
    },
  })
  return supabaseAdminNoCache
}
