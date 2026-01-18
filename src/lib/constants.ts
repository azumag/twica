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

export const DEBUG_CONFIG = {
  ALLOWED_HOSTS: ['localhost', '127.0.0.1', '::1'],
  PRODUCTION_ENV: 'production',
} as const

export const ERROR_MESSAGES = {
  // Authentication errors
  UNAUTHORIZED: 'Unauthorized',
  NOT_AUTHENTICATED: 'Not authenticated',
  FORBIDDEN: 'Forbidden',

  // Request validation errors
  MISSING_REQUIRED_FIELDS: 'Missing required fields',
  INVALID_REQUEST: 'Invalid request',
  INVALID_CARD_ID: 'Invalid card ID',
  USER_CARD_ID_REQUIRED: 'userCardId is required',
  STREAMER_ID_REQUIRED: 'streamerId is required',
  STREAMER_ID_MISSING: 'Missing streamerId',
  DROP_RATE_INVALID: 'Drop rate must be a number between 0 and 1',

  // Rate limit errors
  RATE_LIMIT_EXCEEDED: 'Too many requests. Please try again later.',

  // Resource errors
  USER_NOT_FOUND: 'User not found',
  CARD_NOT_FOUND: 'Card not found',
  CARD_NOT_OWNED: 'Card not found or not owned by user',
  STREAMER_NOT_FOUND: 'Streamer not found',
  NO_CARDS_AVAILABLE: 'No cards available for this streamer',
  FAILED_TO_SELECT_CARD: 'Failed to select card',
  FAILED_TO_RECORD_HISTORY: 'Failed to record gacha history',
  DATABASE_ERROR: 'Database error',
  REWARD_ID_MISMATCH: 'Reward ID mismatch',
  UNEXPECTED_ERROR: 'Unexpected error',

  // File upload errors
  FILE_NAME_EMPTY: 'File name is empty',
  FILE_SIZE_EXCEEDED: 'File size exceeds the maximum allowed size',
  INVALID_FILE_TYPE: 'Invalid file type. Only JPEG and PNG are allowed',
  NO_FILE_SELECTED: 'No file selected',
  UNABLE_TO_UPLOAD: 'Unable to upload file',

  // General errors
  INTERNAL_ERROR: 'Internal server error',
  OPERATION_FAILED: 'Operation failed',

  // Additional authentication errors
  NO_ACCESS_TOKEN_AVAILABLE: 'No access token available',

  // Additional request validation errors
  MISSING_REWARD_ID: 'Missing rewardId',

  // EventSub errors
  INVALID_SIGNATURE: 'Invalid signature',
  UNKNOWN_MESSAGE_TYPE: 'Unknown message type',

  // Twitch API errors
  FAILED_TO_GET_SUBSCRIPTIONS: 'Failed to get subscriptions',

  // Debug errors
  DEBUG_ENDPOINT_NOT_AVAILABLE: 'Debug endpoint not available in production',
  DEBUG_ENDPOINT_NOT_AUTHORIZED: 'Debug endpoint only accessible from localhost',
} as const

export const CPU_CARD_STRINGS = {
  NAME_PREFIX: 'CPUの',
  DEFAULT_NAME: 'CPUカード',
  DEFAULT_SKILL_NAME: 'CPU攻撃',
} as const

export const BATTLE_SKILL_NAMES = {
  ATTACK: ['強撃', '猛攻', '破壊光線', '必殺拳'],
  DEFENSE: ['鉄壁', '硬化', '防御態勢', '守りの陣'],
  HEAL: ['回復', '治癒', '生命の雨', '再生光'],
  SPECIAL: ['混乱攻撃', '急速', '幸運', '奇襲'],
} as const

export const BATTLE_LOG_MESSAGES = {
  SKILL_ATTACK: (attackerName: string, skillName: string, damage: number) =>
    `${attackerName}が${skillName}！${damage}ダメージを与えた！`,
  SKILL_DEFENSE: (attackerName: string, skillName: string, defenseUp: number) =>
    `${attackerName}が${skillName}！防御力が${defenseUp}上がった！`,
  SKILL_HEAL: (attackerName: string, skillName: string, healAmount: number) =>
    `${attackerName}が${skillName}！${healAmount}回復した！`,
  SKILL_SPECIAL: (attackerName: string, skillName: string, specialDamage: number) =>
    `${attackerName}が${skillName}！特殊効果で${specialDamage}ダメージ！`,
  NORMAL_ATTACK: (attackerName: string, damage: number) =>
    `${attackerName}が攻撃！${damage}ダメージを与えた！`,
  SKILL_FAILED: 'スキル発動失敗',
} as const
