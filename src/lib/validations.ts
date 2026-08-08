
import { CARD_DESCRIPTION_MAX_CHARACTERS, TWITCH_CHAT_MESSAGE_MAX_CHARACTERS, ERROR_MESSAGES } from './constants'
import { countCharacters } from './text-utils'
// validateDropRateSumのDB読取はPlanetScale/Drizzleの単一経路。
import { and, eq } from 'drizzle-orm'
import { getDb } from './db/client'

import { withDbRetry } from './db/retry'
import { cards as cardsTable } from './db/schema'

function sumDropRates(
  cards: Array<{ id: string; drop_rate: number }>,
  newDropRate: number,
  excludeCardId?: string
): { valid: boolean; error?: string } {
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

/**
 * validateDropRateSum の pg 直結実装 (#663)
 *
 * 旧 PostgREST 実装との対応:
 * - cards を streamer_id = X AND is_active = true で取得。
 * - 取得失敗時は同じエラーメッセージ（'Failed to validate drop rates'）を返す。
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
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
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

  return sumDropRates(cards, newDropRate, excludeCardId)
}

export async function validateDropRateSum(
  streamerId: string,
  newDropRate: number,
  excludeCardId?: string
): Promise<{ valid: boolean; error?: string }> {
  return validateDropRateSumPg(streamerId, newDropRate, excludeCardId)
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

/**
 * Twitch チャネルポイント報酬 ID の形式検証（UUID）。issue #836。
 *
 * Twitch の報酬 ID は UUID 形式。チャネルポイント報酬の紐付け（streamer/settings）と
 * 追加報酬（additional-rewards）の reward_id として保存されるため、非 UUID の値が
 * EventSub 購読条件（condition.reward_id）と不整合を起こさないようルート層で検証する。
 * null / undefined は「設定なし・クリア」を意味するため許可する。
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateRewardId(rewardId: unknown): { valid: boolean; error?: string } {
  if (rewardId === null || rewardId === undefined) {
    return { valid: true }
  }

  if (typeof rewardId !== 'string') {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  // 空文字列は「報酬なし」を意味する（クライアントは未選択時に "" を送る）
  const trimmedId = rewardId.trim()
  if (trimmedId === '') {
    return { valid: true }
  }

  if (!UUID_REGEX.test(trimmedId)) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  return { valid: true }
}

/**
 * 報酬名の検証（文字列 + 100 字上限 + 制御文字禁止）。issue #836。
 * null / undefined は許可（設定なし・クリアを意味する）。
 * 空文字列（trim後）も validateRewardId と対称に「名前なし」として許可する。
 * ChannelPointSettings.tsx の handleSave は保存のたびに channelPointRewardId/Name を
 * 両方送信するため（useState(currentRewardName || "") で初期化）、reward_name が
 * 未設定な既存データを持つ行では "" が送られうる。ここを拒否すると、そのようなデータを
 * 持つ配信者は無関係な設定変更（パック紐付け等）まで保存できなくなるレグレッションになる。
 */
export function validateRewardName(rewardName: unknown): { valid: boolean; error?: string } {
  if (rewardName === null || rewardName === undefined) {
    return { valid: true }
  }

  if (typeof rewardName !== 'string') {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  const trimmedName = rewardName.trim()

  if (trimmedName === '') {
    return { valid: true }
  }

  if (trimmedName.length > 100) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  if (/[\u0000-\u001f\u007f]/.test(trimmedName)) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  return { valid: true }
}

/**
 * チャット通知テンプレートの検証（文字列 + 500 字上限）。issue #836。
 * null は許可（デフォルトテンプレートを使用）。送信時にも 500 字へ truncate される
 * （chat-service）ため、上限は保存時・送信時の双方で一貫している。
 * 複数行テンプレートは正当なユースケース（UI は textarea rows=3）のため、
 * 改行（LF/CR）とタブは許可する。制御文字チェックは改行・タブを除外する。
 */
const TEMPLATE_CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

export function validateChatAnnouncementTemplate(template: unknown): { valid: boolean; error?: string } {
  if (template === null || template === undefined) {
    return { valid: true }
  }

  if (typeof template !== 'string') {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  if (countCharacters(template) > TWITCH_CHAT_MESSAGE_MAX_CHARACTERS) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  if (TEMPLATE_CONTROL_CHAR_REGEX.test(template)) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  // 空白のみのテンプレートは「通知文が無い」状態になるため拒否する
  if (template.trim() === '') {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }

  return { valid: true }
}

/**
 * カード画像の余白（fit）色の検証 / issue #899。
 * この値は表示側の CSS 背景色（backgroundColor）にそのまま入るため、
 * 任意文字列を許可せず、アプリが生成する4値のみをホワイトリストで許可する。
 * null / undefined は「余白なし」を意味するため許可。
 */
const VALID_PADDING_COLORS = new Set(['black', 'white', 'gray', 'transparent'])

export function validateImagePaddingColor(
  color: unknown
): { valid: boolean; error?: string } {
  // null / undefined / 空文字は「余白なし」を意味するため許可（空文字は API 側で null に変換）
  if (color === null || color === undefined || color === '') {
    return { valid: true }
  }
  if (typeof color !== 'string' || !VALID_PADDING_COLORS.has(color)) {
    return { valid: false, error: ERROR_MESSAGES.INVALID_REQUEST }
  }
  return { valid: true }
}
