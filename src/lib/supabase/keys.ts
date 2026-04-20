function stripKeyWhitespace(value: string | undefined): string | undefined {
  return value?.replace(/\s/g, '')
}

export function getSupabasePublicKey(): string | undefined {
  return stripKeyWhitespace(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )
}

export function getSupabaseElevatedKey(): string | undefined {
  return stripKeyWhitespace(
    process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY
  )
}

