// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 1.0 : 1.0,
  debug: true,

  beforeSend(event, hint) {
    console.log('[Sentry Server] beforeSend called', { event, hint })

    if (event.user) {
      delete event.user.email
      delete event.user.ip_address
    }

    if (event.request?.headers) {
      const { cookie: _cookie, authorization: _auth, ...headers } = event.request.headers
      void _cookie
      void _auth
      event.request.headers = headers
    }

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

    console.log('[Sentry Server] beforeSend returning event')
    return event
  },

  beforeSendTransaction(event) {
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
});
