import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/database'
import { logger } from '@/lib/logger'
import { getSupabasePublicKey } from './keys'

export async function createClient() {
  const cookieStore = await cookies()
  const supabaseKey = getSupabasePublicKey()
  if (!supabaseKey) {
    throw new Error('Missing Supabase public key')
  }

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    supabaseKey,
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
