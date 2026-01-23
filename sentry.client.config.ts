import * as Sentry from '@sentry/nextjs'

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,

  integrations: [
    Sentry.replayIntegration(),
    Sentry.globalHandlersIntegration({
      onerror: true,
      onunhandledrejection: true,
    }),
  ],

  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  replaysSessionSampleRate: process.env.NODE_ENV === 'production' ? 0.01 : 0.1,
  replaysOnErrorSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  beforeSend(event) {
    // Filter out errors from browser extensions (MetaMask, etc.)
    // These are not application errors and should not be tracked
    // Common patterns: app:// protocol, moz-extension://, chrome-extension://
    const frames = event.exception?.values?.[0]?.stacktrace?.frames || []
    const isExtensionError = frames.some(
      (frame) =>
        frame.filename?.startsWith('app://') ||
        frame.filename?.startsWith('moz-extension://') ||
        frame.filename?.startsWith('chrome-extension://') ||
        frame.filename?.includes('inpage.js') ||
        frame.filename?.includes('content-script')
    )
    if (isExtensionError) {
      return null // Drop the event
    }

    if (event.user) {
      delete event.user.email
      delete event.user.ip_address
    }

    return event
  },

  release: process.env.NEXT_PUBLIC_VERSION || 'local',
})
