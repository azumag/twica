import { createClient, SupabaseClient } from '@supabase/supabase-js'

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

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  // 環境変数に改行や空白が混入する場合があるため（Cloudflareダッシュボードでのペースト時など）
  // JWTには空白文字が含まれないため、すべての空白・改行を除去する
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/\s/g, '')

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables')
  }

  supabaseAdmin = createClient(url, key)
  return supabaseAdmin
}

/**
 * Supabase admin client with cache disabled
 * Use this for real-time data queries where cached data would cause issues
 * (e.g., chat announcements that need fresh card count data)
 *
 * キャッシュ無効のSupabase管理クライアント
 * キャッシュされたデータが問題を引き起こすリアルタイムデータクエリに使用
 * （例：最新のカード所持枚数が必要なチャット通知）
 */
export function getSupabaseAdminNoCache(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  // 環境変数に改行や空白が混入する場合があるため（Cloudflareダッシュボードでのペースト時など）
  // JWTには空白文字が含まれないため、すべての空白・改行を除去する
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.replace(/\s/g, '')

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables')
  }

  // Create a new client with cache disabled for each call
  // キャッシュ無効の新しいクライアントを毎回作成
  return createClient(url, key, {
    global: {
      fetch: (url, options = {}) => fetch(url, { ...options, cache: 'no-store' }),
    },
  })
}
