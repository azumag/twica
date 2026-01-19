import * as Sentry from '@sentry/nextjs'

export function reportError(error: Error | unknown, context?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    if (context) {
      Object.entries(context).forEach(([key, value]) => {
        scope.setExtra(key, value)
      })
    }

    if (error instanceof Error) {
      scope.setLevel('error')
      Sentry.captureException(error)
    } else {
      scope.setLevel('warning')
      Sentry.captureMessage(String(error), 'warning')
    }
  })
}

export function reportMessage(message: string, level: 'info' | 'warning' | 'error' = 'info', context?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    if (context) {
      Object.entries(context).forEach(([key, value]) => {
        scope.setExtra(key, value)
      })
    }

    Sentry.captureMessage(message, level)
  })
}

export function reportApiError(endpoint: string, method: string, error: Error | unknown, additionalContext?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    scope.setTag('endpoint', endpoint)
    scope.setTag('method', method)
    scope.setLevel('error')

    if (additionalContext) {
      Object.entries(additionalContext).forEach(([key, value]) => {
        scope.setExtra(key, value)
      })
    }

    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      // 非Error型のエラーを詳細に記録
      let errorMessage = `${method} ${endpoint}: Unknown error`;

      if (typeof error === 'string') {
        errorMessage = `${method} ${endpoint}: ${error}`;
        scope.setExtra('errorType', 'string');
        scope.setExtra('errorValue', error);
      } else if (error && typeof error === 'object') {
        // オブジェクトの場合、すべてのキーと値を記録
        try {
          const errorJson = JSON.stringify(error, null, 2);
          errorMessage = `${method} ${endpoint}: Object error`;
          scope.setExtra('errorType', 'object');
          scope.setExtra('errorObject', error);
          scope.setExtra('errorJson', errorJson);
        } catch (e) {
          errorMessage = `${method} ${endpoint}: [Unserializable Object] - ${e}`;
          scope.setExtra('errorType', 'unserializable');
          scope.setExtra('errorString', String(error));
          scope.setExtra('serializationError', e instanceof Error ? e.message : String(e));
        }
      } else if (error !== undefined && error !== null) {
        errorMessage = `${method} ${endpoint}: ${String(error)}`;
        scope.setExtra('errorType', typeof error);
        scope.setExtra('errorValue', error);
      }

      Sentry.captureMessage(errorMessage, 'error')
    }
  })
}

export function reportAuthError(error: Error | unknown, context: { provider?: string; action?: string; userId?: string }) {
  Sentry.withScope((scope) => {
    scope.setTag('category', 'auth')
    scope.setTag('provider', context.provider || 'unknown')
    scope.setTag('action', context.action || 'unknown')
    scope.setLevel('error')

    if (context.userId) {
      scope.setUser({ id: context.userId })
    }

    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      Sentry.captureMessage(`Auth error: ${String(error)}`, 'error')
    }
  })
}

export function reportGachaError(error: Error | unknown, context: { streamerId?: string; userId?: string; cost?: number }) {
  Sentry.withScope((scope) => {
    scope.setTag('category', 'gacha')
    scope.setLevel('error')

    if (context.streamerId) {
      scope.setExtra('streamerId', context.streamerId)
    }
    if (context.userId) {
      scope.setUser({ id: context.userId })
    }
    if (context.cost) {
      scope.setExtra('cost', context.cost)
    }

    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      Sentry.captureMessage(`Gacha error: ${String(error)}`, 'error')
    }
  })
}

export function reportBattleError(error: Error | unknown, context: { battleId?: string; userId?: string; round?: number }) {
  Sentry.withScope((scope) => {
    scope.setTag('category', 'battle')
    scope.setLevel('error')

    if (context.battleId) {
      scope.setExtra('battleId', context.battleId)
    }
    if (context.userId) {
      scope.setUser({ id: context.userId })
    }
    if (context.round) {
      scope.setExtra('round', context.round)
    }

    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      Sentry.captureMessage(`Battle error: ${String(error)}`, 'error')
    }
  })
}

export function reportPerformanceIssue(operation: string, duration: number, context?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    scope.setTag('category', 'performance')
    scope.setTag('operation', operation)
    scope.setLevel('warning')
    scope.setExtra('duration', duration)

    if (context) {
      Object.entries(context).forEach(([key, value]) => {
        scope.setExtra(key, value)
      })
    }

    Sentry.captureMessage(`Performance issue: ${operation} took ${duration}ms`, 'warning')
  })
}

export function reportRealtimeError(error: unknown, context: { action?: string; streamerId?: string; status?: string; retryCount?: number }) {
  Sentry.withScope((scope) => {
    scope.setTag('category', 'realtime')
    scope.setTag('action', context.action || 'unknown')
    scope.setLevel('error')

    if (context.streamerId) {
      scope.setExtra('streamerId', context.streamerId)
    }
    if (context.status) {
      scope.setExtra('status', context.status)
    }
    if (context.retryCount) {
      scope.setExtra('retryCount', context.retryCount)
    }

    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      Sentry.captureMessage(`Realtime error: ${String(error)}`, 'error')
    }
  })
}

export function reportSecurityError(error: Error | unknown, context: { action?: string; userId?: string; [key: string]: unknown }) {
  Sentry.withScope((scope) => {
    scope.setTag('category', 'security')
    scope.setTag('action', context.action || 'unknown')
    scope.setLevel('error')

    Object.entries(context).forEach(([key, value]) => {
      scope.setExtra(key, value)
    })

    if (error instanceof Error) {
      Sentry.captureException(error)
    } else {
      Sentry.captureMessage(`Security error: ${String(error)}`, 'error')
    }
  })
}