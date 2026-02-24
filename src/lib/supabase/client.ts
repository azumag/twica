import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'

export function createClient() {
  // 環境変数に改行や空白が混入する場合があるため（Cloudflareダッシュボードでのペースト時など）
  // JWTには空白文字が含まれないため、すべての空白・改行を除去する
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.replace(/\s/g, '')
  )
}
