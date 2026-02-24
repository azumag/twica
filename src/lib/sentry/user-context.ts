/**
 * User Context Abstraction Layer (No-op)
 * ユーザーコンテキスト抽象レイヤー（no-op実装）
 *
 * Sentry SDK was removed to reduce bundle size for Cloudflare Workers deployment.
 * These functions are kept as no-ops so callers don't need modification.
 * When error monitoring is re-enabled, implement the real logic here.
 *
 * See: https://github.com/azumag/twica/issues/235
 */

export interface UserContext {
  twitchUserId?: string
  twitchUsername?: string
  broadcasterType?: string
}

// No-op: user context tracking disabled until error monitoring is re-enabled
export function setUserContext(_user: UserContext) {}

// No-op: user context tracking disabled until error monitoring is re-enabled
export function clearUserContext() {}

// No-op: request context tracking disabled until error monitoring is re-enabled
export function setRequestContext(_requestId: string, _path: string) {}

// No-op: game context tracking disabled until error monitoring is re-enabled
export function setGameContext(_gameData: {
  battleId?: string
  cardId?: string
  outcome?: string
}) {}
