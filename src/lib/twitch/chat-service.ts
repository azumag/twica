import { getEnvVar } from '@/lib/env-validation'
import { getBotAccountForChat, getTwitchAccessToken, hasScope } from './token-manager'
import { ADDITIONAL_SCOPES } from './scopes'
import { logger } from '@/lib/logger.server'
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
// EventSub waitUntilの30秒内で、token refresh（最大13秒）とDB処理の後にも
// chat送信を完了させる。各試行3秒 + retry待機合計750msで最大約9.75秒。
const CHAT_SEND_REQUEST_TIMEOUT_MS = 3_000
// 250ms, 500ms。ジッターは付けない（並列度が低く herd 効果が小さいため）。
const CHAT_SEND_RETRY_DELAYS_MS = [250, 500]
/**
 * Twitchが「30秒以内の同一本文」として送信を抑止したときの drop_reason.code。
 *
 * これは障害ではなくTwitch側の意図的な連投抑止であり、通常運用で発生する:
 * チャット通知テンプレートは {user}/{card}/{rarity}/{unique}/{all} を展開するため、
 * 同じ視聴者が同じカードを30秒以内に2回引くと（重複カードなら進捗も変わらないので）
 * 本文が完全一致する。issue #842/#843 がこの経路で自動生成された。
 *
 * 他の drop_reason（AutoMod等）と違い時間依存なので「再送しても直らない」わけではないが、
 * 同一本文は既にチャットへ出ており情報は失われないため、30秒待って古い通知を後から
 * 流すよりも黙って落とすほうが自然（Twitchの抑止意図にも沿う）。
 */
const DUPLICATE_DROP_CODE = 'msg_duplicate'
/**
 * Twitch/CDNの一時応答。408・429と全5xxを同じbounded retryへ統一する。
 * 個別の5xx列挙では522/523/524等のCloudflare障害が恒久失敗としてDLQ化され、
 * 回復後にも再送されないため、HTTPクラスで判定する。
 */
function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

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

interface TwitchChatSendResponse {
  data?: Array<{
    message_id?: string
    is_sent?: boolean
    drop_reason?: {
      code?: string
      message?: string
    } | null
  }>
}

export type ChatSendOutcome =
  | { outcome: 'sent' }
  /**
   * Twitchが同一本文の連投として意図的に抑止したケース（drop_reason=msg_duplicate）。
   * 送信はされていないが障害ではないため、terminalと分けてDLQ・エラー報告の対象外にする。
   * 詳細は下の DUPLICATE_DROP_CODE の解説を参照。
   */
  | { outcome: 'duplicate'; reason: string }
  | { outcome: 'terminal'; reason: string }
  | { outcome: 'retryable'; reason: string }
  | { outcome: 'aborted'; reason: string }

export interface ChatSendOptions {
  /**
   * 資格情報解決後かつ各Twitch fetch直前のfence。false/例外なら外部送信しない。
   * transactional outboxはここでlease所有権を更新し、旧所有者の二重送信を防ぐ。
   */
  beforeExternalSend?: () => Promise<boolean>
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
    const result = await this.sendChatMessageDetailed(broadcasterTwitchUserId, message)
    // duplicate は障害ではない（DUPLICATE_DROP_CODE 参照）。false を返すと呼び出し側が
    // 送信失敗として警告ログを出すため、成功と同じ扱いにする。
    return result.outcome === 'sent' || result.outcome === 'duplicate'
  }

  /**
   * transactional outbox relay向けの分類付き送信。
   * scope/credential欠落と4xxは再試行しても直らないterminal、429/5xx/通信障害は
   * retryableとして返す。既存呼び出しはsendChatMessage()のboolean契約を維持する。
   */
  async sendChatMessageDetailed(
    broadcasterTwitchUserId: string,
    message: string,
    options: ChatSendOptions = {},
  ): Promise<ChatSendOutcome> {
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
        return { outcome: 'terminal', reason: 'user:write:chat scope not granted' }
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
      return { outcome: 'terminal', reason: 'chat sender access token unavailable' }
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
        if (options.beforeExternalSend) {
          try {
            if (!await options.beforeExternalSend()) {
              logger.warn('Chat message aborted before external send - delivery ownership lost', {
                broadcasterTwitchUserId,
                senderTwitchUserId,
                attempt,
              })
              return { outcome: 'aborted', reason: 'chat delivery ownership lost before send' }
            }
          } catch (error) {
            // fence確認不能時に送ると、別relayとの二重送信を否定できない。
            // lease失効後の次回claimへ委ねるため、外部APIはfail-closedで停止する。
            logger.warn('Chat message aborted before external send - delivery fence failed', {
              broadcasterTwitchUserId,
              senderTwitchUserId,
              attempt,
              error: error instanceof Error ? error.message : String(error),
            })
            return {
              outcome: 'aborted',
              reason: `chat delivery fence failed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        }

        // Twitch Helix API: POST /helix/chat/messages
        // sender_id と broadcaster_id を同じにすることで、配信者として投稿
        const response = await fetch(`${TWITCH_API_URL}/chat/messages`, {
          ...requestInit,
          // retryごとに新しいsignalを作る。ループ外で作ると1回目の期限が後続試行にも
          // 引き継がれ、正常なretryまで即時abortされる。
          signal: AbortSignal.timeout(CHAT_SEND_REQUEST_TIMEOUT_MS),
        })

        if (response.ok) {
          // HelixはHTTP 200でもAutoMod等でdata[0].is_sent=falseを返す。statusだけで
          // sent扱いするとoutboxをackして通知を永久欠落させるため、bodyを必ず確認する。
          const successBody = await response.json().catch(() => ({})) as TwitchChatSendResponse
          const sentResult = successBody.data?.[0]
          if (sentResult?.is_sent === true) {
            logger.info('Chat message sent successfully', {
              broadcasterTwitchUserId,
              senderTwitchUserId,
              usingBotAccount: Boolean(botAccount),
              messageLength: countCharacters(truncatedMessage),
              attempt,
            })
            return { outcome: 'sent' }
          }

          const dropCode = sentResult?.drop_reason?.code ?? 'invalid-success-response'
          const dropMessage = sentResult?.drop_reason?.message
            ?? 'Twitch returned 200 without is_sent=true'

          // msg_duplicate は障害ではなくTwitchの連投抑止（issue #842/#843）。
          // 同じ視聴者が同じカードを30秒以内に引くとテンプレート展開後の本文が
          // 完全一致するため通常運用で発生する。同一本文は既にチャットへ出ており
          // 情報は失われないので、DLQ・エラー報告には送らずackする。
          // AutoMod等の他のdrop_reasonは本文自体が拒否されているためterminalのまま。
          if (dropCode === DUPLICATE_DROP_CODE) {
            logger.info('Chat message suppressed by Twitch as a duplicate', {
              broadcasterTwitchUserId,
              senderTwitchUserId,
              usingBotAccount: Boolean(botAccount),
              attempt,
            })
            return { outcome: 'duplicate', reason: dropMessage }
          }

          lastResponse = response
          lastResponseErrorBody = {
            error: dropCode,
            status: response.status,
            message: dropMessage,
          }
          lastException = null
          // 同じ本文を再送してもAutoMod等の判定は変わらないためterminalとし、
          // 後続通知を塞がずDLQから人間が内容を確認できるようにする。
          break
        }

        const errorBody: TwitchApiError = await response.json().catch(() => ({}))
        lastResponse = response
        lastResponseErrorBody = errorBody
        lastException = null

        // 通常の4xxは恒久失敗（401 scope・403禁止・404 not found等）。
        // timeoutを表す408、rate limitの429、全5xxだけを一時障害として再試行する。
        // Ordinary 4xx is terminal; only 408, 429, and all 5xx are retried.
        const isRetryable = isRetryableHttpStatus(response.status) && attempt < CHAT_SEND_MAX_ATTEMPTS
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

      // PlanetScaleへ記録し、Cron Worker経由でGitHub Issueを自動作成する。
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
      return isRetryableHttpStatus(lastResponse.status)
        ? {
            outcome: 'retryable',
            reason: `Twitch API ${lastResponse.status}: ${errorBody.message || 'Unknown error'}`,
          }
        : {
            outcome: 'terminal',
            reason: `Twitch API ${lastResponse.status}: ${errorBody.message || 'Unknown error'}`,
          }
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
    return {
      outcome: 'retryable',
      reason: lastException instanceof Error ? lastException.message : String(lastException),
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
