// Next.js instrumentation hook
// Sentry was removed to reduce bundle size for Cloudflare Workers deployment.
// See: https://github.com/azumag/twica/issues/235
// To re-enable error monitoring, implement @sentry/cloudflare or Cloudflare Tail Workers.
export async function register() {
  // No-op: Sentry server/edge initialization removed for Cloudflare Workers compatibility
}
