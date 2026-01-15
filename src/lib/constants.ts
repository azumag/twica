export const BROADCASTER_TYPE = {
  AFFILIATE: 'affiliate' as const,
  PARTNER: 'partner' as const,
  NONE: '' as const,
}

export const TWITCH_SUBSCRIPTION_TYPE = {
  CHANNEL_POINTS_REDEMPTION_ADD: 'channel.channel_points_custom_reward_redemption.add' as const,
}

export const COOKIE_NAMES = {
  SESSION: 'twica_session',
  AUTH_STATE: 'twitch_auth_state',
}

export const API_ROUTES = {
  AUTH_TWITCH_CALLBACK: '/api/auth/twitch/callback',
  AUTH_TWITCH_LOGIN: '/api/auth/twitch/login',
  AUTH_LOGOUT: '/api/auth/logout',
}

export const SESSION_CONFIG = {
  MAX_AGE_SECONDS: 60 * 60 * 24 * 30,
  COOKIE_PATH: '/',
}
