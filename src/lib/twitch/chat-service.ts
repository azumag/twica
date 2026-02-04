import { getEnvVar } from '@/lib/env-validation'
import { getTwitchAccessToken, removeScope } from './token-manager'
import { ADDITIONAL_SCOPES } from './auth'
import { logger } from '@/lib/logger'

const TWITCH_API_URL = 'https://api.twitch.tv/helix'

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
    try {
      // 配信者本人のアクセストークンを取得（user:write:chatスコープが必要）
      // Get the broadcaster's access token (requires user:write:chat scope)
      const accessToken = await getTwitchAccessToken(broadcasterTwitchUserId)

      if (!accessToken) {
        logger.warn('No access token available for broadcaster', { broadcasterTwitchUserId })
        return false
      }

      // メッセージを500文字に制限（Twitch APIの制限）
      // Truncate message to 500 characters (Twitch API limit)
      const truncatedMessage = message.length > 500 ? message.substring(0, 497) + '...' : message

      // Twitch Helix API: POST /helix/chat/messages
      // sender_id と broadcaster_id を同じにすることで、配信者として投稿
      const response = await fetch(`${TWITCH_API_URL}/chat/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Client-Id': this.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          broadcaster_id: broadcasterTwitchUserId,
          sender_id: broadcasterTwitchUserId,
          message: truncatedMessage,
        }),
      })

      if (!response.ok) {
        const errorBody: TwitchApiError = await response.json().catch(() => ({}))
        logger.error('Failed to send chat message', {
          status: response.status,
          error: errorBody,
          broadcasterTwitchUserId,
        })

        // 401かつスコープ不足の場合、DBからスコープを削除して不整合を解消する
        // トークンが実際にはuser:write:chatを持っていないケースへの自己修復
        // On 401 with missing scope, remove the scope from DB to fix token/scope mismatch.
        // Self-healing for cases where the token doesn't actually have user:write:chat.
        //
        // Twitch APIのスコープ不足時のエラーメッセージは複数パターンがある:
        // - "User access token requires the user:write:chat scope." (実際に観測済み)
        // - "Insufficient authorization in token" (Twitch公式ドキュメントの汎用形式)
        // Both known Twitch error messages for insufficient scope are handled:
        // - Explicit scope name in message (observed in production)
        // - Generic "Insufficient authorization" (per Twitch API docs)
        const isScopeError = response.status === 401 && (
          errorBody.message?.includes('user:write:chat') ||
          errorBody.message?.includes('Insufficient authorization')
        )
        if (isScopeError) {
          try {
            await removeScope(broadcasterTwitchUserId, ADDITIONAL_SCOPES.CHAT_WRITE)
            logger.warn('Removed invalid user:write:chat scope from DB (self-healing)', {
              broadcasterTwitchUserId,
            })
          } catch (removeScopeError) {
            logger.error('Failed to remove invalid scope during self-healing', {
              broadcasterTwitchUserId,
              error: removeScopeError,
            })
          }
        }

        return false
      }

      logger.info('Chat message sent successfully', {
        broadcasterTwitchUserId,
        messageLength: truncatedMessage.length,
      })

      return true
    } catch (error) {
      logger.error('Error sending chat message', {
        error,
        broadcasterTwitchUserId,
      })
      return false
    }
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

    // 連続する空白を1つにまとめ、前後の空白を削除
    // Normalize whitespace
    return message.replace(/\s+/g, ' ').trim()
  }
}
