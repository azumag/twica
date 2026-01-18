import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,

  beforeSend(event) {
    if (event.user) {
      delete event.user.email
      delete event.user.ip_address
    }

    return event
  },

  release: process.env.NEXT_PUBLIC_VERSION || 'local',
})
