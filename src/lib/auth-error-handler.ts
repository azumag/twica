import { NextResponse } from 'next/server'
import { logger } from './logger'
import { reportAuthError } from './sentry/error-handler'

enum AuthErrorType {
  // Twitch APIエラー
  TWITCH_AUTH_FAILED = 'twitch_auth_failed',
  TWITCH_USER_FETCH_FAILED = 'twitch_user_fetch_failed',
  
  // データベースエラー
  DATABASE_ERROR = 'database_error',
  DATABASE_CONNECTION_FAILED = 'database_connection_failed',
  
  // 環境変数エラー
  MISSING_ENV_VAR = 'missing_env_var',
  
  // バリデーションエラー
  INVALID_STATE = 'invalid_state',
  MISSING_PARAMS = 'missing_params',
  INVALID_AUTHORIZATION_CODE = 'invalid_authorization_code',
  
  // その他のエラー
  UNKNOWN_ERROR = 'unknown_error',
}

interface AuthErrorDetails {
  type: string
  message: string
  statusCode: number
  userMessage: string
  shouldLog: boolean
}

function isTransientTwitchProviderFailure(error: unknown, errorType: string): boolean {
  if (errorType !== 'twitch_auth_failed' && errorType !== 'twitch_user_fetch_failed') {
    return false
  }
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number'
    && (status === 408 || status === 429 || (status >= 500 && status <= 599))
}

const TWITCH_TEMPORARY_USER_MESSAGE =
  'Twitch側で一時的な通信エラーが発生しました。少し待ってから再度お試しください。'

const AUTH_ERROR_MAP: Record<string, AuthErrorDetails> = {
  twitch_auth_failed: {
    type: 'twitch_auth_failed',
    message: 'Twitch authentication failed',
    statusCode: 500,
    userMessage: 'Twitchとの認証に失敗しました。しばらく待ってから再度お試しください。',
    shouldLog: true,
  },
  twitch_user_fetch_failed: {
    type: 'twitch_user_fetch_failed',
    message: 'Failed to fetch Twitch user data',
    statusCode: 500,
    userMessage: 'ユーザー情報の取得に失敗しました。しばらく待ってから再度お試しください。',
    shouldLog: true,
  },
  database_error: {
    type: 'database_error',
    message: 'Database operation failed',
    statusCode: 500,
    userMessage: 'データベースエラーが発生しました。しばらく待ってから再度お試しください。',
    shouldLog: true,
  },
  database_connection_failed: {
    type: 'database_connection_failed',
    message: 'Failed to connect to database',
    statusCode: 500,
    userMessage: 'サーバーでエラーが発生しました。管理者にお問い合わせください。',
    shouldLog: true,
  },
  missing_env_var: {
    type: 'missing_env_var',
    message: 'Missing required environment variables',
    statusCode: 500,
    userMessage: 'サーバー設定エラーが発生しました。管理者にお問い合わせください。',
    shouldLog: true,
  },
  invalid_state: {
    type: 'invalid_state',
    message: 'Invalid OAuth state parameter',
    statusCode: 400,
    userMessage: '認証セッションが無効です。再度ログインしてください。',
    shouldLog: false,
  },
  missing_params: {
    type: 'missing_params',
    message: 'Missing required OAuth parameters',
    statusCode: 400,
    userMessage: '必要なパラメータが不足しています。再度ログインしてください。',
    shouldLog: false,
  },
  invalid_authorization_code: {
    type: 'invalid_authorization_code',
    message: 'Invalid or expired OAuth authorization code',
    statusCode: 400,
    userMessage: '認証コードが無効か期限切れです。再度ログインしてください。',
    shouldLog: false,
  },
  unknown_error: {
    type: 'unknown_error',
    message: 'Unknown error occurred',
    statusCode: 500,
    userMessage: '予期しないエラーが発生しました。しばらく待ってから再度お試しください。',
    shouldLog: true,
  },
}

/**
 * Handle authentication errors with appropriate response format
 * 認証エラーを適切なレスポンス形式で処理する
 *
 * @param error - The error object
 * @param errorType - The type of error for lookup in AUTH_ERROR_MAP
 * @param context - Additional context for logging
 * @param options - Response options
 * @param options.returnJson - If true, return JSON response instead of redirect (for API routes)
 *                             trueの場合、リダイレクトではなくJSONレスポンスを返す（APIルート用）
 * @param options.baseUrl - Base URL for redirect (Cloudflare Workers では NEXT_PUBLIC_APP_URL が
 *                          ビルド時にインライン化されるため、リクエストから取得した baseUrl を渡す)
 */
export async function handleAuthError(
  error: unknown,
  errorType: string,
  context?: Record<string, unknown>,
  options?: { returnJson?: boolean; baseUrl?: string }
): Promise<NextResponse> {
  const errorDetails = AUTH_ERROR_MAP[errorType] || AUTH_ERROR_MAP.unknown_error
  // Twitch endpoint自身が返した408/429/5xxは、アプリの修正で解消する恒久バグではない。
  // callbackの利用者には一時障害として案内し、自動GitHub Issueの永続化対象から外す。
  // 401/403/4xx等は従来どおり各エラー種別の契約を維持する。
  const transientTwitchFailure = isTransientTwitchProviderFailure(error, errorType)
  const shouldPersist = errorDetails.shouldLog && !transientTwitchFailure
  const responseStatus = transientTwitchFailure ? 503 : errorDetails.statusCode
  const userMessage = transientTwitchFailure
    ? TWITCH_TEMPORARY_USER_MESSAGE
    : errorDetails.userMessage

  if (errorDetails.shouldLog) {
    // 一時的なTwitch provider障害もWorkerログには残す。ただし logger.error は
    // 自動永続化するためwarningに限定し、errors/GitHub Issue化はshouldPersistで分ける。
    logger.warn(`${errorDetails.message}:`, {
      error,
      errorType,
      context,
      stack: error instanceof Error ? error.stack : undefined,
    })
  }

  if (shouldPersist) {
    // Cloudflare Workersではレスポンス完了後に未完了タスクがキャンセルされるため、
    // PlanetScaleへのエラー記録をawaitして自動issue連携を確実にする。
    await reportAuthError(error, {
      provider: 'twitch',
      action: errorType.replace(/_/g, '-'),
      userId: context?.twitchUserId as string || undefined,
    })
  }

  // Return JSON for API routes (fetch requests that expect JSON)
  // APIルート用にJSONを返す（JSONを期待するfetchリクエスト用）
  if (options?.returnJson) {
    return NextResponse.json(
      {
        error: errorDetails.type,
        message: userMessage,
      },
      { status: responseStatus }
    )
  }

  // Cloudflare Workers では NEXT_PUBLIC_APP_URL がビルド時にインライン化されるため、
  // options.baseUrl が渡されていればそちらを優先する
  const redirectBase = options?.baseUrl || process.env.NEXT_PUBLIC_APP_URL
  return NextResponse.redirect(
    `${redirectBase}/?error=${encodeURIComponent(userMessage)}`
  )
}

export { AuthErrorType }
