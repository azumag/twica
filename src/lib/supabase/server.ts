import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'

export async function createClient() {
  const cookieStore = await cookies()

  // 環境変数に改行や空白が混入する場合があるため（Cloudflareダッシュボードでのペースト時など）
  // JWTには空白文字が含まれないため、すべての空白・改行を除去する
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.replace(/\s/g, ''),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch (error) {
            // Server Component からの cookie 書き込みは Next.js で禁止されている (Issue #271)
            // Supabase SSR がトークンリフレッシュ時に setAll() を呼ぶが、
            // Server Component コンテキストでは失敗する。ログで可視化する。
            logger.warn('[Supabase] Cookie set failed (likely Server Component context)', {
              cookieNames: cookiesToSet.map(c => c.name),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      },
    }
  )
}
