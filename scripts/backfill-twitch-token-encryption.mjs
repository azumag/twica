import { createClient } from '@supabase/supabase-js'

const PAGE_SIZE = 100
const IV_LENGTH = 12
const encoder = new TextEncoder()

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function getSupabaseSecretKey() {
  return process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
}

async function getEncryptionKey() {
  const keyHash = await crypto.subtle.digest('SHA-256', encoder.encode(requireEnv('TWITCH_TOKEN_ENCRYPTION_KEY')))
  return crypto.subtle.importKey('raw', keyHash, { name: 'AES-GCM' }, false, ['encrypt'])
}

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

async function encryptToken(key, token) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(token))
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(encrypted))}`
}

async function backfillBatch(supabase, key, from, to) {
  const { data: users, error } = await supabase
    .from('users')
    .select('twitch_user_id, twitch_access_token, twitch_refresh_token, twitch_token_expires_at')
    .not('twitch_access_token', 'is', null)
    .not('twitch_refresh_token', 'is', null)
    .range(from, to)

  if (error) {
    throw error
  }

  if (!users || users.length === 0) {
    return 0
  }

  for (const user of users) {
    const encryptedAccessToken = await encryptToken(key, user.twitch_access_token)
    const encryptedRefreshToken = await encryptToken(key, user.twitch_refresh_token)

    const { error: upsertError } = await supabase
      .from('twitch_oauth_tokens')
      .upsert({
        twitch_user_id: user.twitch_user_id,
        encrypted_access_token: encryptedAccessToken,
        encrypted_refresh_token: encryptedRefreshToken,
        token_expires_at: user.twitch_token_expires_at ?? new Date().toISOString(),
      }, {
        onConflict: 'twitch_user_id',
      })

    if (upsertError) {
      throw upsertError
    }

    const { error: clearError } = await supabase
      .from('users')
      .update({
        twitch_access_token: null,
        twitch_refresh_token: null,
        twitch_token_expires_at: null,
      })
      .eq('twitch_user_id', user.twitch_user_id)

    if (clearError) {
      throw clearError
    }
  }

  return users.length
}

async function main() {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL')
  const supabaseKey = getSupabaseSecretKey()
  if (!supabaseKey) {
    throw new Error('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required')
  }

  const supabase = createClient(supabaseUrl, supabaseKey)
  const key = await getEncryptionKey()
  let migrated = 0

  while (true) {
    const count = await backfillBatch(supabase, key, 0, PAGE_SIZE - 1)
    migrated += count

    if (count < PAGE_SIZE) {
      break
    }
  }

  console.log(`Encrypted and cleared ${migrated} legacy Twitch token rows.`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
