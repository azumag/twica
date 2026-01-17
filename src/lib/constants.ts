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
  MAX_AGE_SECONDS: 7 * 24 * 60 * 60,  // 7 days
  MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  COOKIE_PATH: '/',
}

export const RARITIES = [
  { value: "common", label: "コモン", color: "bg-gray-500" },
  { value: "rare", label: "レア", color: "bg-blue-500" },
  { value: "epic", label: "エピック", color: "bg-purple-500" },
  { value: "legendary", label: "レジェンダリー", color: "bg-yellow-500" },
] as const;

export const RARITY_ORDER = ["legendary", "epic", "rare", "common"];

export const RARITY_COLORS = {
  legendary: "bg-yellow-500",
  epic: "bg-purple-500",
  rare: "bg-blue-500",
  common: "bg-gray-500",
};

export const GACHA_COST = parseInt(process.env.GACHA_COST || '100', 10)
