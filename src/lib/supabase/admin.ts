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

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing Supabase environment variables')
  }

  supabaseAdmin = createClient(url, key)
  return supabaseAdmin
}
