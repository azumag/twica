/**
 * Fail-closed Cache-Control directive for responses that must never be stored.
 *
 * This module is intentionally dependency-free because it is imported by
 * `src/middleware.ts` and therefore must remain safe for the Edge runtime.
 */
export const PRIVATE_NO_STORE_CACHE_CONTROL = 'private, no-store'
