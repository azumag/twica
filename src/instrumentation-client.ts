// This file is REQUIRED for Next.js 15+ App Router to initialize Sentry on the client-side
// This file is REQUIRED for Next.js 15+ App Router to initialize Sentry on the client-side
// DO NOT DELETE - Sentry SDK does not auto-initialize in Next.js App Router
import * as Sentry from "@sentry/nextjs";

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
  
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  
    replaysSessionSampleRate: process.env.NODE_ENV === "production" ? 0.01 : 0.1,
    replaysOnErrorSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  
    beforeSend(event) {
          if (event.user) {
                  delete event.user.email;
                  delete event.user.ip_address;
          }
          return event;
    },
});// DO NOT DELETE - sentry.client.config.ts is NOT automatically loaded in Next.js App Router
import "../sentry.client.config";
