import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,

  beforeSend(event) {
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

    return event
  },

  release: process.env.NEXT_PUBLIC_VERSION || 'local',
})
