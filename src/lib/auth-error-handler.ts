import { NextResponse } from 'next/server'
import { logger } from './logger'

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
  unknown_error: {
    type: 'unknown_error',
    message: 'Unknown error occurred',
    statusCode: 500,
    userMessage: '予期しないエラーが発生しました。しばらく待ってから再度お試しください。',
    shouldLog: true,
  },
}

export function handleAuthError(
  error: unknown,
  errorType: string,
  context?: Record<string, unknown>
): NextResponse {
  const errorDetails = AUTH_ERROR_MAP[errorType] || AUTH_ERROR_MAP.unknown_error
  
  if (errorDetails.shouldLog) {
    logger.error(`${errorDetails.message}:`, {
      error,
      errorType,
      context,
      stack: error instanceof Error ? error.stack : undefined,
    })
  }

  return NextResponse.redirect(
    `${process.env.NEXT_PUBLIC_APP_URL}/?error=${encodeURIComponent(errorDetails.userMessage)}`
  )
}

export { AuthErrorType }