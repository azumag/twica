import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'
import { getSupabasePublicKey } from './keys'

export function createClient() {
  const supabaseKey = getSupabasePublicKey()
  if (!supabaseKey) {
    throw new Error('Missing Supabase public key')
  }

  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    supabaseKey
  )
}
