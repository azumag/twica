import { getSupabaseAdmin } from './supabase/admin'
import { CARD_DESCRIPTION_MAX_CHARACTERS, ERROR_MESSAGES, RARITIES } from './constants'
import { countCharacters } from './text-utils'

export async function validateDropRateSum(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  newDropRate: number,
  excludeCardId?: string
): Promise<{ valid: boolean; error?: string }> {
  const { data: cards, error } = await supabaseAdmin
    .from('cards')
    .select('id, drop_rate')
    .eq('streamer_id', streamerId)
    .eq('is_active', true)

  if (error) {
    return { valid: false, error: 'Failed to validate drop rates' }
  }

  const currentSum = cards
    .filter((c) => c.id !== excludeCardId)
    .reduce((sum, c) => sum + (c.drop_rate || 0), 0)

  const newSum = currentSum + newDropRate

  if (newSum > 1.0) {
    return {
      valid: false,
      error: `Total drop rate would be ${(newSum * 100).toFixed(1)}% (max 100%). Current: ${(currentSum * 100).toFixed(1)}%, New: ${(newDropRate * 100).toFixed(1)}%`,
    }
  }

  return { valid: true }
}

export function validateCardName(name: unknown): { valid: boolean; error?: string } {
  if (typeof name !== 'string') {
    return { valid: false, error: ERROR_MESSAGES.CARD_NAME_REQUIRED }
  }

  const trimmedName = name.trim()

  if (trimmedName.length === 0) {
    return { valid: false, error: ERROR_MESSAGES.CARD_NAME_REQUIRED }
  }

  if (trimmedName.length > 100) {
    return { valid: false, error: ERROR_MESSAGES.CARD_NAME_TOO_LONG }
  }

  return { valid: true }
}

export function validateCardDescription(description: unknown): { valid: boolean; error?: string } {
  if (description === null || description === undefined) {
    return { valid: true }
  }

  if (typeof description !== 'string') {
    return { valid: false, error: ERROR_MESSAGES.DESCRIPTION_TOO_LONG }
  }

  if (countCharacters(description) > CARD_DESCRIPTION_MAX_CHARACTERS) {
    return { valid: false, error: ERROR_MESSAGES.DESCRIPTION_TOO_LONG }
  }

  return { valid: true }
}

// Allowed image extensions for external URLs
// 外部URLの許可された画像拡張子
const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

// Trusted image CDN domains that don't require extension validation
// 拡張子検証が不要な信頼できる画像CDNドメイン
const TRUSTED_IMAGE_DOMAINS = [
  'static-cdn.jtvnw.net',     // Twitch emotes
  'blob.vercel-storage.com',  // Vercel Blob storage
  'public.blob.vercel-storage.com', // Vercel Blob public storage
]

export function validateImageUrl(imageUrl: unknown): { valid: boolean; error?: string } {
  if (imageUrl === null || imageUrl === undefined) {
    return { valid: true }
  }

  if (typeof imageUrl !== 'string') {
    return { valid: false, error: ERROR_MESSAGES.INVALID_IMAGE_URL }
  }

  // Empty string is allowed (means no image)
  // 空文字列は許可（画像なしを意味する）
  if (imageUrl.trim() === '') {
    return { valid: true }
  }

  try {
    const url = new URL(imageUrl)

    // Only allow HTTPS protocol
    // HTTPSプロトコルのみ許可
    if (url.protocol !== 'https:') {
      return { valid: false, error: ERROR_MESSAGES.INVALID_IMAGE_URL }
    }

    // Skip extension check for trusted CDN domains
    // 信頼できるCDNドメインの場合は拡張子チェックをスキップ
    const isTrustedDomain = TRUSTED_IMAGE_DOMAINS.some(domain =>
      url.hostname === domain || url.hostname.endsWith('.' + domain)
    )

    if (isTrustedDomain) {
      return { valid: true }
    }

    // Check file extension for other domains
    // その他のドメインはファイル拡張子をチェック
    const pathname = url.pathname.toLowerCase()
    const hasValidExtension = ALLOWED_IMAGE_EXTENSIONS.some((ext) =>
      pathname.endsWith(ext)
    )

    if (!hasValidExtension) {
      return { valid: false, error: ERROR_MESSAGES.INVALID_IMAGE_URL }
    }

    return { valid: true }
  } catch {
    return { valid: false, error: ERROR_MESSAGES.INVALID_IMAGE_URL }
  }
}

// Disallowed control / formatting characters for free-text display fields.
// 表示名に紛れ込むと UI を破壊したり、視覚スプーフィングに利用される可能性がある
// 文字を除去する。具体的には以下を弾く:
//   - C0/C1 制御文字 (NULL, BS, ESC, 改行, タブなど) と DEL
//     (U+0000-U+001F, U+007F-U+009F)
//   - Zero-width / 不可視文字 (U+200B-U+200F, U+FEFF) - 改ざん検知回避を防止
//   - Unicode bidi override (U+202A-U+202E, U+2066-U+2069) - 表示順スプーフィング対策
//
// 正規表現リテラルに生の制御文字を埋め込むとファイルがバイナリ扱いされ、
// 差分レビューや lint が破綻するため、Unicode escapes を含む文字列から
// `RegExp` をコンストラクトする。
const DISALLOWED_DISPLAY_CHARS = new RegExp(
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]',
  'g'
)

/**
 * 視聴者向けに表示される自由入力テキストを正規化する。
 * 制御文字や bidi override などを除去した上で前後の空白をトリムする。
 * 結果が空文字列の場合は null を返し、呼び出し側で「未設定」として扱えるようにする。
 *
 * Normalize free-text input that will be rendered to viewers. Strips control
 * characters, zero-width chars, and bidi overrides before trimming. Returns
 * `null` when the resulting string is empty so callers can treat it as unset.
 */
export function normalizeCollectionName(value: string): string | null {
  const sanitized = value.replace(DISALLOWED_DISPLAY_CHARS, '').trim()
  return sanitized.length === 0 ? null : sanitized
}

export function validateRarity(rarity: unknown): { valid: boolean; error?: string } {
  if (typeof rarity !== 'string') {
    return { valid: false, error: ERROR_MESSAGES.INVALID_RARITY }
  }

  const allowedRarities = RARITIES.map(r => r.value)

  if (!allowedRarities.includes(rarity as 'common' | 'rare' | 'epic' | 'legendary')) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_RARITY }
  }

  return { valid: true }
}
