import { getEnvVar } from '@/lib/env-validation'
import { getTwitchAccessToken, hasScope } from './token-manager'
import { ADDITIONAL_SCOPES } from './auth'
import { logger } from '@/lib/logger'
import { reportApiError, reportError } from '@/lib/sentry/error-handler'

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
      // 送信前にDBのスコープを確認（無駄なAPI呼び出し抑止）
      // Check DB scope before sending to avoid unnecessary API calls (e.g., repeated 401s from EventSub)
      const hasChatScope = await hasScope(broadcasterTwitchUserId, ADDITIONAL_SCOPES.CHAT_WRITE)
      if (!hasChatScope) {
        logger.info('Skipping chat message - user:write:chat scope not granted', { broadcasterTwitchUserId })
        return false
      }

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

        // 401かつスコープ不足の場合、ログのみ出力しDBは変更しない
        // sub-check.tsと同じ方針: 401/403でのスコープ除去は行わず、スコープ除去はユーザーの手動確認APIでのみ行う
        // 別端末ログイン等でトークンにスコープがない場合、再認証で復旧するためDB保護が重要
        // On 401 with missing scope, only log a warning without modifying DB.
        // Follows sub-check.ts pattern: scope removal only via user-initiated verification API.
        // When token lacks scope (e.g., login from another device), DB preservation allows recovery via re-auth.
        if (response.status === 401 && (
          errorBody.message?.includes('user:write:chat') ||
          errorBody.message?.includes('Insufficient authorization')
        )) {
          logger.warn('Twitch API returned 401 for chat scope - token/DB mismatch detected (DB preserved)', {
            broadcasterTwitchUserId,
            twitchError: errorBody.message,
          })
        }

        // Supabase に記録し、Cron Worker 経由で GitHub Issue を自動作成する
        // Report to Supabase so the Cron Worker can create a GitHub Issue
        // 自己修復の後に配置（自己修復が確実に実行されるようにするため）
        // Placed after self-healing to ensure healing runs regardless of reporting outcome
        // try-catch で囲む: reportApiError の失敗が return false をブロックしないようにする
        // Wrapped in try-catch so reportApiError failure doesn't prevent return false
        try {
          await reportApiError('/helix/chat/messages', 'POST',
            new Error(`Twitch API ${response.status}: ${errorBody.message || 'Unknown error'}`),
            { broadcasterTwitchUserId, status: response.status, twitchError: errorBody.error }
          )
        } catch {
          // reportApiError 自体の失敗はベストエフォート — メインフローをブロックしない
          // reportApiError failure is best-effort — must not block main flow
        }

        return false
      }

      logger.info('Chat message sent successfully', {
        broadcasterTwitchUserId,
        messageLength: truncatedMessage.length,
      })

      return true
    } catch (error) {
      // ネットワークエラーなど予期しない例外をSupabaseに記録
      // reportError 内部で console.error も出力される
      // try-catch で囲む: reportError の失敗で例外が sendChatMessage 外に漏れないようにする
      // Wrapped in try-catch so reportError failure doesn't leak exceptions to callers
      try {
        await reportError(error, {
          context: 'chat-service:sendChatMessage',
          broadcasterTwitchUserId,
        })
      } catch {
        // reportError 自体の失敗はベストエフォート — 必ず return false に到達させる
        // reportError failure is best-effort — must always reach return false
      }
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
