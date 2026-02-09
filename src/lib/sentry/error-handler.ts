/**
 * Error Reporting Abstraction Layer
 * エラーレポート抽象レイヤー
 *
 * Sentry SDK was removed to reduce bundle size for Cloudflare Workers deployment
 * (Sentry was duplicated 4x by Turbopack, consuming ~16.8MB of the 23MB bundle).
 * This layer is maintained as an abstraction so that error monitoring can be
 * re-enabled by changing only the implementation in this file.
 *
 * 現在の実装: console.error + Supabase errors テーブルへの記録
 * Supabase に記録されたエラーは Cron Worker (twica-error-reporter) が
 * 定期的に読み出して GitHub Issue を自動作成する。
 *
 * See: https://github.com/azumag/twica/issues/235 (Sentry削除)
 * See: https://github.com/azumag/twica/issues/239 (エラー監視再導入)
 */

/**
 * Supabase errors テーブルにエラーを記録する。
 *
 * - サーバーサイド (Cloudflare Workers) でのみ動作
 * - クライアントサイドでは getSupabaseAdmin() が失敗するため無視される
 * - Supabase への記録失敗はメインのエラー処理を阻害しない
 * - fetch() の I/O wait は Workers の CPU 時間 (10ms) にカウントされない
 *
 * dynamic import する理由:
 * - error-handler.ts はクライアント・サーバー両方からインポートされる
 * - サーバーサイドでのみ Supabase クライアントをロードする
 */

// context に含まれる可能性のある機密情報キー（小文字で照合）
// userId は Supabase Auth の UUID であり PII に該当するため除外
const SENSITIVE_KEYS = [
  'password', 'token', 'authorization', 'cookie', 'secret',
  'apikey', 'userid', 'username', 'api_key', 'access_token', 'refresh_token',
  'client_secret', 'credential', 'private_key', 'email', 'ip_address',
]

/**
 * context オブジェクトから機密情報を除外する。
 * GitHub Issue に context がそのまま記載されるため、PII 漏洩を防止。
 */
function sanitizeContext(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k))) {
      sanitized[key] = '[REDACTED]'
    } else if (Array.isArray(value)) {
      // 配列内のオブジェクトも再帰的にサニタイズ
      // 例: [{ userId: 'abc' }] → [{ userId: '[REDACTED]' }]
      sanitized[key] = value.map(item => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          return sanitizeContext(item as Record<string, unknown>)
        }
        return item
      })
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeContext(value as Record<string, unknown>)
    } else {
      sanitized[key] = value
    }
  }
  return sanitized
}

/**
 * unknown 型のエラーから可読なメッセージを抽出する。
 * Supabase PostgrestError のようなプレーンオブジェクト（Error 非継承）でも
 * message プロパティがあれば取得し、なければ JSON.stringify でフォールバック。
 * See: https://github.com/azumag/twica/issues/262
 */
function extractErrorMessage(error: unknown): string {
  // 注: この関数は report*Error 関数の else 分岐（error instanceof Error が false の場合）でのみ呼ばれる
  if (error && typeof error === 'object') {
    if ('message' in error && typeof (error as Record<string, unknown>).message === 'string') {
      return (error as Record<string, unknown>).message as string
    }
    try {
      return JSON.stringify(error)
    } catch {
      return '[Unserializable object]'
    }
  }
  return String(error)
}

// PostgreSQL TEXT 型は最大1GBだが、実用的な上限として定数化
const MAX_MESSAGE_LENGTH = 10000
const MAX_STACK_LENGTH = 50000

async function logErrorToSupabase(
  errorType: string,
  message: string,
  stackTrace: string | null,
  context: Record<string, unknown>
): Promise<void> {
  try {
    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const supabase = getSupabaseAdmin()

    // 環境判定: NEXT_PUBLIC_APP_URL に 'preview' が含まれるかで判定
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    const environment = appUrl.includes('preview') ? 'preview' : 'production'

    await supabase.from('errors').insert({
      error_type: errorType,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      stack_trace: stackTrace?.slice(0, MAX_STACK_LENGTH) || null,
      // 機密情報（userId, token 等）を除外してから記録
      context: sanitizeContext(context),
      environment,
    })
  } catch (err) {
    // Supabase への記録失敗はメインのエラー処理を阻害しない
    // エラー詳細を出力して Cloudflare Workers Observability (wrangler tail) で確認可能にする
    console.warn('[Error Tracking] Failed to log error to Supabase:', err)
  }
}

export async function reportError(error: Error | unknown, context?: Record<string, unknown>) {
  if (error instanceof Error) {
    console.error('[Error]', error.message, context ?? '')
    await logErrorToSupabase('[Error]', error.message, error.stack || null, context || {})
  } else {
    const msg = extractErrorMessage(error)
    console.warn('[Warning]', msg, context ?? '')
    await logErrorToSupabase('[Warning]', msg, null, context || {})
  }
}

export async function reportApiError(endpoint: string, method: string, error: Error | unknown, additionalContext?: Record<string, unknown>) {
  const label = `${method} ${endpoint}`
  const ctx = { endpoint, method, ...additionalContext }
  if (error instanceof Error) {
    console.error(`[API Error] ${label}:`, error.message, additionalContext ?? '')
    await logErrorToSupabase('[API Error]', `${label}: ${error.message}`, error.stack || null, ctx)
  } else {
    const msg = extractErrorMessage(error)
    console.error(`[API Error] ${label}:`, msg, additionalContext ?? '')
    await logErrorToSupabase('[API Error]', `${label}: ${msg}`, null, ctx)
  }
}

export async function reportAuthError(error: Error | unknown, context: { provider?: string; action?: string; userId?: string }) {
  if (error instanceof Error) {
    console.error('[Auth Error]', error.message, context)
    await logErrorToSupabase('[Auth Error]', error.message, error.stack || null, context)
  } else {
    const msg = extractErrorMessage(error)
    console.error('[Auth Error]', msg, context)
    await logErrorToSupabase('[Auth Error]', msg, null, context)
  }
}

export async function reportGachaError(error: Error | unknown, context: { streamerId?: string; userId?: string; cost?: number }) {
  if (error instanceof Error) {
    console.error('[Gacha Error]', error.message, context)
    await logErrorToSupabase('[Gacha Error]', error.message, error.stack || null, context)
  } else {
    const msg = extractErrorMessage(error)
    console.error('[Gacha Error]', msg, context)
    await logErrorToSupabase('[Gacha Error]', msg, null, context)
  }
}

export async function reportBattleError(error: Error | unknown, context: { battleId?: string; userId?: string; round?: number }) {
  if (error instanceof Error) {
    console.error('[Battle Error]', error.message, context)
    await logErrorToSupabase('[Battle Error]', error.message, error.stack || null, context)
  } else {
    const msg = extractErrorMessage(error)
    console.error('[Battle Error]', msg, context)
    await logErrorToSupabase('[Battle Error]', msg, null, context)
  }
}

export async function reportRealtimeError(error: unknown, context: { action?: string; streamerId?: string; status?: string; retryCount?: number; isExpected?: boolean }) {
  // Suppress expected connection events (CLOSED, TIMED_OUT, CHANNEL_ERROR)
  // to avoid noise in logs, matching previous Sentry behavior
  // 期待されるステータスはログもSupabase記録もスキップ
  const EXPECTED_STATUSES = ['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR']

  if (context.isExpected || (context.status && EXPECTED_STATUSES.includes(context.status))) {
    return
  }

  if (error instanceof Error) {
    console.error('[Realtime Error]', error.message, context)
    await logErrorToSupabase('[Realtime Error]', error.message, error.stack || null, context)
  } else {
    const msg = extractErrorMessage(error)
    console.error('[Realtime Error]', msg, context)
    await logErrorToSupabase('[Realtime Error]', msg, null, context)
  }
}

export async function reportSecurityError(error: Error | unknown, context: { action?: string; userId?: string; [key: string]: unknown }) {
  if (error instanceof Error) {
    console.error('[Security Error]', error.message, context)
    await logErrorToSupabase('[Security Error]', error.message, error.stack || null, context)
  } else {
    const msg = extractErrorMessage(error)
    console.error('[Security Error]', msg, context)
    await logErrorToSupabase('[Security Error]', msg, null, context)
  }
}
