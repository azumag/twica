import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  debug: process.env.NODE_ENV === 'development',
  
  beforeSend(event, hint) {
    // Filter out sensitive information
    if (event.user) {
      delete event.user.email
      delete event.user.ip_address
    }

    // Filter out sensitive data in request headers
    if (event.request?.headers) {
      const { cookie: _cookie, authorization: _auth, ...headers } = event.request.headers
      // Unused variables are for filtering sensitive data
      void _cookie
      void _auth
      event.request.headers = headers
    }

    // Add custom context for debugging
    if (event.exception) {
      const error = hint.originalException
      if (error instanceof Error) {
        event.contexts = {
          ...event.contexts,
          custom: {
            ...event.contexts?.custom,
            errorMessage: error.message,
            errorName: error.name,
          }
        }
      }
    }
    return event
  },

  beforeSendTransaction(event) {
    // Filter out Next.js internal requests
    if (event.request?.url?.includes('/_next')) {
      return null
    }
    return event
  },



  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Non-Error promise rejection captured',
    'Request aborted',
    'Network request failed',
    'ChunkLoadError',
  ],

  denyUrls: [
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    /^safari-extension:\/\//,
  ],

  release: process.env.NEXT_PUBLIC_VERSION || 'local',
})