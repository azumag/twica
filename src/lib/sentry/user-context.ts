import * as Sentry from '@sentry/nextjs'

export interface UserContext {
  twitchUserId?: string
  twitchUsername?: string
  broadcasterType?: string
}

export function setUserContext(user: UserContext) {
  Sentry.setUser({
    id: user.twitchUserId,
    username: user.twitchUsername,
    segment: user.broadcasterType ? 'streamer' : 'viewer',
  })
}

export function clearUserContext() {
  Sentry.setUser(null)
}

export function setRequestContext(requestId: string, path: string) {
  Sentry.setContext('request', {
    requestId,
    path,
  })
}

export function setFeatureContext(features: string[]) {
  Sentry.setContext('features', {
    enabled: features,
  })
}

export function setGameContext(gameData: {
  battleId?: string
  cardId?: string
  outcome?: string
}) {
  Sentry.setContext('game', gameData)
}

export function setGachaContext(gachaData: {
  gachaId?: string
  cardId?: string
  cost?: number
}) {
  Sentry.setContext('gacha', gachaData)
}

export function setStreamContext(streamData: {
  streamerId?: string
  streamTitle?: string
  gameId?: string
}) {
  Sentry.setContext('stream', streamData)
}