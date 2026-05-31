import { getSupabaseAdmin } from './supabase/admin'
import { CARD_DESCRIPTION_MAX_CHARACTERS, ERROR_MESSAGES } from './constants'
import { CARD_MEDIA_TYPES, type CardMediaType } from './card-media'
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
const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v']

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

export function validateCardMediaType(mediaType: unknown): { valid: boolean; error?: string } {
  if (mediaType === undefined || mediaType === null) {
    return { valid: true }
  }

  if (typeof mediaType !== 'string' || !CARD_MEDIA_TYPES.includes(mediaType as CardMediaType)) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_MEDIA_TYPE }
  }

  return { valid: true }
}

// 動画URLのホスト allowlist。環境変数 ALLOWED_VIDEO_HOSTS をカンマ区切りで設定すると
// 列挙されたホストのみ受け入れる。未設定時は後方互換のため素通しするが warn ログを出す。
// (PR #449 レビュー指摘: 外部ホスト無制限・MITM/コンテンツ差し替えリスク)
function getAllowedVideoHosts(): string[] | null {
  const raw = process.env.ALLOWED_VIDEO_HOSTS?.trim()
  if (!raw) return null
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0)
}

function isAllowedVideoHost(hostname: string, allowed: string[]): boolean {
  const lower = hostname.toLowerCase()
  return allowed.some((entry) => lower === entry || lower.endsWith('.' + entry))
}

export function validateCardMediaUrl(mediaUrl: unknown, mediaType: CardMediaType): { valid: boolean; error?: string } {
  if (mediaType === 'image') {
    return validateImageUrl(mediaUrl)
  }

  if (mediaUrl === null || mediaUrl === undefined) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_VIDEO_URL }
  }

  if (typeof mediaUrl !== 'string' || mediaUrl.trim() === '') {
    return { valid: false, error: ERROR_MESSAGES.INVALID_VIDEO_URL }
  }

  try {
    const url = new URL(mediaUrl)
    if (url.protocol !== 'https:') {
      return { valid: false, error: ERROR_MESSAGES.INVALID_VIDEO_URL }
    }

    const pathname = url.pathname.toLowerCase()
    const hasValidExtension = ALLOWED_VIDEO_EXTENSIONS.some((ext) => pathname.endsWith(ext))
    if (!hasValidExtension) {
      return { valid: false, error: ERROR_MESSAGES.INVALID_VIDEO_URL }
    }

    // ホスト allowlist チェック。env 未設定時は後方互換維持のため通すが、
    // 設定されている場合は厳格に検証する。
    const allowedHosts = getAllowedVideoHosts()
    if (allowedHosts && !isAllowedVideoHost(url.hostname, allowedHosts)) {
      return { valid: false, error: ERROR_MESSAGES.INVALID_VIDEO_URL }
    }

    return { valid: true }
  } catch {
    return { valid: false, error: ERROR_MESSAGES.INVALID_VIDEO_URL }
  }
}

export function validateRarity(rarity: unknown): { valid: boolean; error?: string } {
  if (typeof rarity !== 'string') {
    return { valid: false, error: ERROR_MESSAGES.INVALID_RARITY }
  }

  const trimmedRarity = rarity.trim()

  if (trimmedRarity.length === 0 || trimmedRarity.length > 40) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_RARITY }
  }

  if (/[\u0000-\u001f\u007f]/.test(trimmedRarity)) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_RARITY }
  }

  return { valid: true }
}
