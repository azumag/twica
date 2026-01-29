/**
 * Error Reporting Abstraction Layer
 * エラーレポート抽象レイヤー
 *
 * Sentry SDK was removed to reduce bundle size for Cloudflare Workers deployment
 * (Sentry was duplicated 4x by Turbopack, consuming ~16.8MB of the 23MB bundle).
 * This layer is maintained as an abstraction so that error monitoring can be
 * re-enabled (e.g. via @sentry/cloudflare or Tail Workers) by changing only
 * the implementation in this file.
 *
 * See: https://github.com/azumag/twica/issues/235
 */

export function reportError(error: Error | unknown, context?: Record<string, unknown>) {
  if (error instanceof Error) {
    console.error('[Error]', error.message, context ?? '')
  } else {
    console.warn('[Warning]', String(error), context ?? '')
  }
}

export function reportApiError(endpoint: string, method: string, error: Error | unknown, additionalContext?: Record<string, unknown>) {
  const label = `${method} ${endpoint}`
  if (error instanceof Error) {
    console.error(`[API Error] ${label}:`, error.message, additionalContext ?? '')
  } else {
    console.error(`[API Error] ${label}:`, String(error), additionalContext ?? '')
  }
}

export function reportAuthError(error: Error | unknown, context: { provider?: string; action?: string; userId?: string }) {
  if (error instanceof Error) {
    console.error('[Auth Error]', error.message, context)
  } else {
    console.error('[Auth Error]', String(error), context)
  }
}

export function reportGachaError(error: Error | unknown, context: { streamerId?: string; userId?: string; cost?: number }) {
  if (error instanceof Error) {
    console.error('[Gacha Error]', error.message, context)
  } else {
    console.error('[Gacha Error]', String(error), context)
  }
}

export function reportBattleError(error: Error | unknown, context: { battleId?: string; userId?: string; round?: number }) {
  if (error instanceof Error) {
    console.error('[Battle Error]', error.message, context)
  } else {
    console.error('[Battle Error]', String(error), context)
  }
}

export function reportRealtimeError(error: unknown, context: { action?: string; streamerId?: string; status?: string; retryCount?: number; isExpected?: boolean }) {
  // Suppress expected connection events (CLOSED, TIMED_OUT, CHANNEL_ERROR)
  // to avoid noise in logs, matching previous Sentry behavior
  const EXPECTED_STATUSES = ['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR']

  if (context.isExpected || (context.status && EXPECTED_STATUSES.includes(context.status))) {
    return
  }

  if (error instanceof Error) {
    console.error('[Realtime Error]', error.message, context)
  } else {
    console.error('[Realtime Error]', String(error), context)
  }
}

export function reportSecurityError(error: Error | unknown, context: { action?: string; userId?: string; [key: string]: unknown }) {
  if (error instanceof Error) {
    console.error('[Security Error]', error.message, context)
  } else {
    console.error('[Security Error]', String(error), context)
  }
}
