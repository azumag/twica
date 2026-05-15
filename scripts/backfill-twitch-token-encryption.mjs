import { createClient } from '@supabase/supabase-js'

const PAGE_SIZE = 100
const IV_LENGTH = 12
// HKDF info パラメータは src/lib/twitch/token-encryption.ts と必ず一致させる
// MUST match HKDF info in src/lib/twitch/token-encryption.ts
const HKDF_INFO = 'twitch-oauth-token-v1'
const MIN_SECRET_BYTES = 32
const MAX_CONSECUTIVE_FAILURES = 3
const MAX_BATCH_ITERATIONS = 10000 // セーフティ: 想定外の無限ループ防止

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
  const secret = requireEnv('TWITCH_TOKEN_ENCRYPTION_KEY')

  if (encoder.encode(secret).byteLength < MIN_SECRET_BYTES) {
    throw new Error(
      `TWITCH_TOKEN_ENCRYPTION_KEY must be at least ${MIN_SECRET_BYTES} bytes (recommend 32 random bytes encoded as base64)`
    )
  }

  // HKDF (RFC 5869) で AES-GCM 鍵を導出。token-encryption.ts と同一手順。
  // HKDF (RFC 5869) key derivation; identical to token-encryption.ts.
  const ikm = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encoder.encode(HKDF_INFO),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )
}

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

async function encryptToken(key, token, twitchUserId) {
  if (!twitchUserId) {
    throw new Error('twitchUserId is required as AAD')
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(twitchUserId) },
    key,
    encoder.encode(token)
  )
  return `v1:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(encrypted))}`
}

/**
 * 1 バッチ分をバックフィルする。
 *
 * range は常に 0..PAGE_SIZE-1 で固定する。各バッチ後 clearLegacyTwitchTokenColumns で
 * 該当 users.twitch_access_token を null に更新するため、次回クエリの
 * `.not('twitch_access_token', 'is', null)` フィルタで自動的に対象が縮小していく。
 * 残件が PAGE_SIZE 未満になればループを抜ける。
 *
 * Always page from 0..PAGE_SIZE-1: each batch nulls out the source rows so the
 * next query's `.not('twitch_access_token', 'is', null)` filter naturally
 * shrinks the candidate set. Loop exits when fewer than PAGE_SIZE rows remain.
 *
 * 戻り値: { processed, skipped }
 *   processed: 暗号化と clear に成功した行数
 *   skipped:   token_expires_at 欠損などでスキップした行数
 */
async function backfillBatch(supabase, key) {
  const { data: users, error } = await supabase
    .from('users')
    .select('twitch_user_id, twitch_access_token, twitch_refresh_token, twitch_token_expires_at')
    .not('twitch_access_token', 'is', null)
    .not('twitch_refresh_token', 'is', null)
    .range(0, PAGE_SIZE - 1)

  if (error) {
    throw error
  }

  if (!users || users.length === 0) {
    return { processed: 0, skipped: 0, fetched: 0 }
  }

  let processed = 0
  let skipped = 0

  for (const user of users) {
    // token_expires_at 欠損は now() で埋めると即時期限切れ扱いとなり、
    // 利用側で誤動作するリスクがある。安全側に倒してスキップ + 警告ログ。
    // Missing token_expires_at would otherwise be treated as "expired now",
    // causing downstream side-effects. Skip + warn instead of fabricating.
    if (!user.twitch_token_expires_at) {
      console.warn(
        `Skipping user ${user.twitch_user_id}: missing twitch_token_expires_at; row left intact for manual review.`
      )
      skipped++
      continue
    }

    const encryptedAccessToken = await encryptToken(key, user.twitch_access_token, user.twitch_user_id)
    const encryptedRefreshToken = await encryptToken(key, user.twitch_refresh_token, user.twitch_user_id)

    const { error: upsertError } = await supabase
      .from('twitch_oauth_tokens')
      .upsert(
        {
          twitch_user_id: user.twitch_user_id,
          encrypted_access_token: encryptedAccessToken,
          encrypted_refresh_token: encryptedRefreshToken,
          token_expires_at: user.twitch_token_expires_at,
        },
        { onConflict: 'twitch_user_id' }
      )

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
      // ここで throw すると connection-level な一過性失敗で全行が再暗号化対象になる。
      // 連続失敗カウンタで判定するために呼び出し元へ返す。
      // Throwing here would force re-encryption of all rows on transient errors;
      // bubble up via return so caller can apply consecutive-failure threshold.
      return { processed, skipped, fetched: users.length, clearError }
    }
  }

  return { processed: processed + (users.length - skipped), skipped, fetched: users.length }
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
  let totalSkipped = 0
  let consecutiveFailures = 0
  let iterations = 0

  while (true) {
    iterations++
    if (iterations > MAX_BATCH_ITERATIONS) {
      throw new Error(
        `Halting backfill after ${MAX_BATCH_ITERATIONS} iterations (safety guard against infinite loops).`
      )
    }

    const { processed, skipped, fetched, clearError } = await backfillBatch(supabase, key)
    migrated += processed
    totalSkipped += skipped

    if (clearError) {
      consecutiveFailures++
      console.warn(
        `clearLegacy failed (attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
        clearError.message ?? clearError
      )
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
          `Halting backfill after ${consecutiveFailures} consecutive clear failures. Last error: ${clearError.message ?? clearError}`
        )
      }
      // 短い遅延で再試行（指数的に増やすほどではないが過負荷を緩和）
      // Brief backoff before retry to avoid hammering the DB.
      await new Promise((resolve) => setTimeout(resolve, 500 * consecutiveFailures))
      continue
    }

    consecutiveFailures = 0

    // 取得件数が PAGE_SIZE 未満ならクエリ対象がなくなった = 完了
    // Fewer than PAGE_SIZE rows fetched means the candidate set is exhausted.
    if (fetched < PAGE_SIZE) {
      break
    }

    // 全件 skip だった場合は対象が縮まらず無限ループになるため終了
    // If every fetched row was skipped, the candidate set won't shrink; stop.
    if (skipped === fetched) {
      console.warn(
        `All ${fetched} rows in this batch were skipped (e.g., missing token_expires_at). Halting to avoid infinite loop.`
      )
      break
    }
  }

  console.log(
    `Encrypted and cleared ${migrated} legacy Twitch token rows. Skipped ${totalSkipped} rows requiring manual review.`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
