import { getEnvVar } from '@/lib/env-validation'
import { getBotAccountForChat, getTwitchAccessToken, hasScope } from './token-manager'
import { ADDITIONAL_SCOPES } from './scopes'
import { logger } from '@/lib/logger'
import { reportApiError, reportError } from '@/lib/sentry/error-handler'
import { countCharacters, truncateCharacters } from '@/lib/text-utils'
import { TWITCH_CHAT_MESSAGE_MAX_CHARACTERS } from '@/lib/constants'

const TWITCH_API_URL = 'https://api.twitch.tv/helix'

// 一時的な障害（Twitch API 5xx, 429 Rate Limit, ネットワーク例外）に対してのみリトライ。
// 4xx (401/403/404) は永続的失敗として即座に返す。
// 過剰なリトライは EventSub の DO CPU time を圧迫するため、最大2回（合計3試行）に抑える。
// Retry only on transient failures (Twitch API 5xx / 429 / network exceptions).
// 4xx (401/403/404) is treated as terminal failure. Capped at 2 retries (3 attempts total)
// to avoid excessive DO CPU time on the EventSub path. See Issue #389.
const CHAT_SEND_MAX_ATTEMPTS = 3
// 250ms, 500ms。ジッターは付けない（並列度が低く herd 効果が小さいため）。
const CHAT_SEND_RETRY_DELAYS_MS = [250, 500]
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504])

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * チャット通知のプレースホルダー型
 * Placeholders available for chat announcement templates
 */
export interface ChatMessagePlaceholders {
  // ガチャを引いたユーザーのTwitch表示名
  // Twitch display name of the user who drew the gacha
  user: string
  // 獲得したカードの名前
  // Name of the card obtained
  card: string
  // 複数枚ガチャ時の獲得カード名一覧（オプション）
  // All obtained card names for multi-draw announcements (optional)
  cards?: string
  // 複数枚ガチャ時の抽選回数（オプション）
  // Draw count for multi-draw announcements (optional)
  draws?: number
  // 複数枚ガチャ時のレアリティ別枚数（例: レアx3、コモンx3）
  // Rarity counts for multi-draw announcements (e.g. Rare x3, Common x3)
  rarityCounts?: string
  // 複数枚ガチャで今回初めて獲得したカード名一覧（オプション）
  // Newly obtained card names in the current multi-draw announcement (optional)
  newCards?: string
  // 複数枚ガチャで今回初めて獲得したカードの種類数（オプション）
  // Count of newly obtained card types in the current multi-draw announcement (optional)
  newCardCount?: number
  // カードのレアリティ（日本語または英語）
  // Card rarity (Japanese or English)
  rarity: string
  // 配信者のコレクションページURL（オプション）
  // Streamer's collection page URL (optional)
  url?: string
  // カードの説明（オプション）
  // Card description (optional)
  detail?: string
  // ユーザーがこのカードを何枚目に獲得したか（オプション）
  // How many of this card the user now owns (optional)
  num?: number
  // コンプ進捗用: 配信者のアクティブカードのうちユーザーが所持しているユニーク種類数（オプション）
  // Collection progress: number of unique active card types the user owns for this streamer (optional)
  unique?: number
  // コンプ進捗用: 配信者のアクティブカードの総種類数（オプション）
  // Collection progress: total number of active card types for this streamer (optional)
  all?: number
  // 獲得したカードが属するパックの表示名（オプション）。抽選がパックに絞られて
  // いない場合や値が空文字の場合は未指定として扱われ、プレースホルダーは空文字に置換される
  // Display name of the pack the obtained card belongs to (optional). Treated as
  // unset when the draw wasn't restricted to a pack or the value is an empty
  // string; the placeholder is then replaced with an empty string (Issue #597)
  packName?: string
}

/**
 * デフォルトのチャット通知テンプレート
 * Default chat announcement template
 * 配信者がカスタムテンプレートを設定していない場合に使用
 */
export const DEFAULT_CHAT_TEMPLATE = '@{user} が【{rarity}】{card} を獲得しました！'

/**
 * Twitch APIエラーレスポンスの型
 */
interface TwitchApiError {
  error?: string
  status?: number
  message?: string
}

/**
 * Twitch Chat Service
 * Twitch Helix APIを使用してチャットメッセージを送信するサービス
 */
export class TwitchChatService {
  private clientId: string

  constructor() {
    this.clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
  }

  /**
   * Twitchチャットにメッセージを送信
   * Send a message to Twitch chat using Helix API
   *
   * @param broadcasterTwitchUserId - 配信者のTwitchユーザーID
   * @param message - 送信するメッセージ（500文字以内）
   * @returns 成功した場合はtrue、失敗した場合はfalse
   */
  async sendChatMessage(broadcasterTwitchUserId: string, message: string): Promise<boolean> {
    const botAccount = await getBotAccountForChat(broadcasterTwitchUserId)
    let senderTwitchUserId = broadcasterTwitchUserId
    let accessToken = botAccount?.accessToken ?? null

    if (botAccount) {
      senderTwitchUserId = botAccount.senderId
    } else {
      // 送信前にDBのスコープを確認（無駄なAPI呼び出し抑止）
      // Check DB scope before sending to avoid unnecessary API calls (e.g., repeated 401s from EventSub)
      const hasChatScope = await hasScope(broadcasterTwitchUserId, ADDITIONAL_SCOPES.CHAT_WRITE)
      if (!hasChatScope) {
        logger.info('Skipping chat message - user:write:chat scope not granted', { broadcasterTwitchUserId })
        return false
      }

      // 配信者本人のアクセストークンを取得（user:write:chatスコープが必要）
      // Get the broadcaster's access token (requires user:write:chat scope)
      accessToken = await getTwitchAccessToken(broadcasterTwitchUserId)
    }

    if (!accessToken) {
      logger.warn('No access token available for chat sender', {
        broadcasterTwitchUserId,
        senderTwitchUserId,
        usingBotAccount: Boolean(botAccount),
      })
      return false
    }

    // メッセージを500文字に制限（Twitch APIの制限）
    // Truncate message to 500 characters (Twitch API limit)
    const truncatedMessage = countCharacters(message) > TWITCH_CHAT_MESSAGE_MAX_CHARACTERS
      ? `${truncateCharacters(message, TWITCH_CHAT_MESSAGE_MAX_CHARACTERS - 3)}...`
      : message

    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client-Id': this.clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        broadcaster_id: broadcasterTwitchUserId,
        sender_id: senderTwitchUserId,
        message: truncatedMessage,
      }),
    }

    // 一時的な障害（5xx / 429 / ネットワーク例外）に対してのみ最大2回リトライ。
    // 各試行の最終的な「エラーの素」を保持し、全試行失敗時に1度だけ報告する。
    // Retry only on transient failures; record the last error to report once after exhaustion.
    let lastResponse: Response | null = null
    let lastResponseErrorBody: TwitchApiError | null = null
    let lastException: unknown = null

    for (let attempt = 1; attempt <= CHAT_SEND_MAX_ATTEMPTS; attempt++) {
      try {
        // Twitch Helix API: POST /helix/chat/messages
        // sender_id と broadcaster_id を同じにすることで、配信者として投稿
        const response = await fetch(`${TWITCH_API_URL}/chat/messages`, requestInit)

        if (response.ok) {
          logger.info('Chat message sent successfully', {
            broadcasterTwitchUserId,
            senderTwitchUserId,
            usingBotAccount: Boolean(botAccount),
            messageLength: countCharacters(truncatedMessage),
            attempt,
          })
          return true
        }

        const errorBody: TwitchApiError = await response.json().catch(() => ({}))
        lastResponse = response
        lastResponseErrorBody = errorBody
        lastException = null

        // 4xx は永続的失敗とみなしリトライしない（401 スコープ・403 禁止・404 not found 等）。
        // 429 と 5xx のみリトライ対象。
        // 4xx is terminal (not retryable). Only 429 and 5xx are retried.
        const isRetryable = RETRYABLE_HTTP_STATUSES.has(response.status) && attempt < CHAT_SEND_MAX_ATTEMPTS
        if (!isRetryable) {
          break
        }

        logger.warn('Twitch chat message transient failure - retrying', {
          broadcasterTwitchUserId,
          senderTwitchUserId,
          usingBotAccount: Boolean(botAccount),
          status: response.status,
          attempt,
          nextDelayMs: CHAT_SEND_RETRY_DELAYS_MS[attempt - 1],
        })
        await sleep(CHAT_SEND_RETRY_DELAYS_MS[attempt - 1])
      } catch (error) {
        // ネットワーク例外（fetch reject）はリトライ対象。最終試行のみ外で報告する。
        // Network exception (fetch reject) is retryable; only the final one will be reported.
        lastException = error
        lastResponse = null
        lastResponseErrorBody = null

        if (attempt >= CHAT_SEND_MAX_ATTEMPTS) {
          break
        }

        logger.warn('Twitch chat message network error - retrying', {
          broadcasterTwitchUserId,
          senderTwitchUserId,
          usingBotAccount: Boolean(botAccount),
          attempt,
          nextDelayMs: CHAT_SEND_RETRY_DELAYS_MS[attempt - 1],
          error: error instanceof Error ? error.message : String(error),
        })
        await sleep(CHAT_SEND_RETRY_DELAYS_MS[attempt - 1])
      }
    }

    // 全試行が失敗。HTTPエラー or ネットワーク例外のいずれかを1度だけ報告する。
    // All attempts exhausted. Report exactly once.
    if (lastResponse !== null) {
      const errorBody = lastResponseErrorBody ?? {}

      // 401かつスコープ不足の場合、ログのみ出力しDBは変更しない
      // sub-check.tsと同じ方針: 401/403でのスコープ除去は行わず、スコープ除去はユーザーの手動確認APIでのみ行う
      // 別端末ログイン等でトークンにスコープがない場合、再認証で復旧するためDB保護が重要
      // On 401 with missing scope, only log a warning without modifying DB.
      // Follows sub-check.ts pattern: scope removal only via user-initiated verification API.
      // When token lacks scope (e.g., login from another device), DB preservation allows recovery via re-auth.
      if (lastResponse.status === 401 && (
        errorBody.message?.includes('user:write:chat') ||
        errorBody.message?.includes('Insufficient authorization')
      )) {
        logger.warn('Twitch API returned 401 for chat scope - token/DB mismatch detected (DB preserved)', {
          broadcasterTwitchUserId,
          senderTwitchUserId,
          usingBotAccount: Boolean(botAccount),
          twitchError: errorBody.message,
        })
      }

      // Supabase に記録し、Cron Worker 経由で GitHub Issue を自動作成する
      // Report to Supabase so the Cron Worker can create a GitHub Issue
      // try-catch で囲む: reportApiError の失敗が return false をブロックしないようにする
      // Wrapped in try-catch so reportApiError failure doesn't prevent return false
      try {
        await reportApiError('/helix/chat/messages', 'POST',
          new Error(`Twitch API ${lastResponse.status}: ${errorBody.message || 'Unknown error'}`),
          {
            broadcasterTwitchUserId,
            senderTwitchUserId,
            usingBotAccount: Boolean(botAccount),
            status: lastResponse.status,
            twitchError: errorBody.error,
          }
        )
      } catch {
        // reportApiError 自体の失敗はベストエフォート — メインフローをブロックしない
        // reportApiError failure is best-effort — must not block main flow
      }
      return false
    }

    // ネットワーク例外パス。reportError 内部で console.error も出力される
    // try-catch で囲む: reportError の失敗で例外が sendChatMessage 外に漏れないようにする
    // Network exception path. Wrapped in try-catch so reportError failure doesn't leak.
    try {
      await reportError(lastException, {
        context: 'chat-service:sendChatMessage',
        broadcasterTwitchUserId,
        senderTwitchUserId,
        usingBotAccount: Boolean(botAccount),
      })
    } catch {
      // reportError 自体の失敗はベストエフォート — 必ず return false に到達させる
      // reportError failure is best-effort — must always reach return false
    }
    return false
  }

  /**
   * テンプレートからメッセージを構築
   * Build message from template with placeholders
   *
   * @param template - メッセージテンプレート（nullの場合はデフォルトを使用）
   * @param placeholders - プレースホルダーの値
   * @returns 構築されたメッセージ
   */
  buildMessage(template: string | null, placeholders: ChatMessagePlaceholders): string {
    // テンプレートが指定されていない場合はデフォルトを使用
    // Use default template if none specified
    const messageTemplate = template || DEFAULT_CHAT_TEMPLATE

    // プレースホルダーを置換
    // Replace placeholders with actual values
    let message = messageTemplate
      .replace(/\{user\}/g, placeholders.user)
      .replace(/\{card\}/g, placeholders.card)
      .replace(/\{rarity\}/g, placeholders.rarity)

    // オプションのプレースホルダーを置換（値がある場合のみ）
    // Replace optional placeholders only if values are provided
    if (placeholders.url) {
      message = message.replace(/\{url\}/g, placeholders.url)
    } else {
      // URLプレースホルダーを削除
      message = message.replace(/\{url\}/g, '')
    }

    if (placeholders.detail) {
      message = message.replace(/\{detail\}/g, placeholders.detail)
    } else {
      message = message.replace(/\{detail\}/g, '')
    }

    if (placeholders.num !== undefined) {
      message = message.replace(/\{num\}/g, String(placeholders.num))
    } else {
      message = message.replace(/\{num\}/g, '')
    }

    // コンプ進捗プレースホルダー: 値が渡された場合のみ置換、未指定時は削除
    // Collection progress placeholders: substitute only when provided, otherwise strip
    if (placeholders.unique !== undefined) {
      message = message.replace(/\{unique\}/g, String(placeholders.unique))
    } else {
      message = message.replace(/\{unique\}/g, '')
    }

    if (placeholders.all !== undefined) {
      message = message.replace(/\{all\}/g, String(placeholders.all))
    } else {
      message = message.replace(/\{all\}/g, '')
    }

    if (placeholders.cards) {
      message = message.replace(/\{cards\}/g, placeholders.cards)
    } else {
      message = message.replace(/\{cards\}/g, '')
    }

    if (placeholders.draws !== undefined) {
      message = message.replace(/\{draws\}/g, String(placeholders.draws))
    } else {
      message = message.replace(/\{draws\}/g, '')
    }

    if (placeholders.rarityCounts) {
      message = message.replace(/\{rarityCounts\}/g, placeholders.rarityCounts)
    } else {
      message = message.replace(/\{rarityCounts\}/g, '')
    }

    if (placeholders.newCards) {
      message = message.replace(/\{newCards\}/g, placeholders.newCards)
    } else {
      message = message.replace(/\{newCards\}/g, '')
    }

    if (placeholders.newCardCount !== undefined) {
      message = message.replace(/\{newCardCount\}/g, String(placeholders.newCardCount))
    } else {
      message = message.replace(/\{newCardCount\}/g, '')
    }

    if (placeholders.packName) {
      message = message.replace(/\{packName\}/g, placeholders.packName)
    } else {
      // パック未指定の抽選（無制限ガチャ）の場合は空文字に置換
      // Strip the placeholder when the draw wasn't restricted to a pack
      message = message.replace(/\{packName\}/g, '')
    }

    // 連続する空白を1つにまとめ、前後の空白を削除
    // Normalize whitespace
    return message.replace(/\s+/g, ' ').trim()
  }
}
