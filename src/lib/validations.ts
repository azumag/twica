import { getSupabaseAdmin } from './supabase/admin'
import { CARD_DESCRIPTION_MAX_CHARACTERS, ERROR_MESSAGES } from './constants'
import { countCharacters } from './text-utils'
// -----------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。
// validateDropRateSum は読み取り専用のため isPgReadEnabled() で分岐する。
// 既存 supabase-js 実装は 1 文字も変えず、フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { and, eq } from 'drizzle-orm'
import { getDb } from './db/client'
import { isPgReadEnabled } from './db/flags'
import { withDbRetry } from './db/retry'
import { cards as cardsTable } from './db/schema'

/**
 * validateDropRateSum の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - cards の streamer_id + is_active = true 絞り込みは .eq() 2 つの AND と同じ。
 * - drop_rate は Drizzle スキーマの numeric mode: 'number' により PostgREST の
 *   JSON number と同じ number で返る（合計計算のパリティ）。
 * - クエリ失敗は既存の error 分岐と同じ { valid: false, error: 'Failed to
 *   validate drop rates' }（pg はエラーが throw になるため catch で吸収。
 *   既存経路はログを出さないため、こちらもログは withDbRetry の [db:pg] warn
 *   のみに任せる）。
 * - 合計判定ロジック（excludeCardId 除外・1.0 超過チェック・エラーメッセージ）は
 *   既存実装と同一の式を使う。
 */
async function validateDropRateSumPg(
  streamerId: string,
  newDropRate: number,
  excludeCardId?: string
): Promise<{ valid: boolean; error?: string }> {
  let cards: Array<{ id: string; drop_rate: number }>
  try {
    cards = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ id: cardsTable.id, drop_rate: cardsTable.drop_rate })
          .from(cardsTable)
          .where(and(eq(cardsTable.streamer_id, streamerId), eq(cardsTable.is_active, true)))
      },
      'validateDropRateSum',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
  } catch {
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

export async function validateDropRateSum(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  streamerId: string,
  newDropRate: number,
  excludeCardId?: string
): Promise<{ valid: boolean; error?: string }> {
  // #663: 読み取り専用の関数のため isPgReadEnabled() で分岐。pg 経路では引数の
  // supabaseAdmin は使わない（呼び出し側の署名を変えないために受け取るだけ。
  // Phase 4 の PostgREST 撤去時に引数ごと削除予定）。
  // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
  if (isPgReadEnabled()) {
    return validateDropRateSumPg(streamerId, newDropRate, excludeCardId)
  }

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
