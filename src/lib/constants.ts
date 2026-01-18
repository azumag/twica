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
  INVALID_FILE_TYPE: 'Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed',
  NO_FILE_SELECTED: 'No file selected',
  UNABLE_TO_UPLOAD: 'Unable to upload file',
  FILE_CONTENT_MISMATCH: 'File content does not match extension',

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

export const CARD_STAT_RANGES = {
  common: {
    hp: { min: 100, max: 120 },
    atk: { min: 20, max: 30 },
    def: { min: 10, max: 15 },
    spd: { min: 1, max: 3 },
    skill_power: { min: 5, max: 10 },
  },
  rare: {
    hp: { min: 120, max: 140 },
    atk: { min: 30, max: 40 },
    def: { min: 15, max: 20 },
    spd: { min: 3, max: 5 },
    skill_power: { min: 10, max: 15 },
  },
  epic: {
    hp: { min: 140, max: 160 },
    atk: { min: 40, max: 45 },
    def: { min: 20, max: 25 },
    spd: { min: 5, max: 7 },
    skill_power: { min: 15, max: 20 },
  },
  legendary: {
    hp: { min: 160, max: 200 },
    atk: { min: 45, max: 50 },
    def: { min: 25, max: 30 },
    spd: { min: 7, max: 10 },
    skill_power: { min: 20, max: 25 },
  },
} as const

export const CARD_STAT_DEFAULTS = {
  hp: 100,
  atk: 30,
  def: 15,
  spd: 5,
  skill_power: 10,
} as const

export const BATTLE_CONFIG = {
  MAX_TURNS: 20,
  SKILL_SPEED_MULTIPLIER: 10,
  SKILL_TRIGGER_MAX_PERCENT: 70,
  RANDOM_RANGE: 100,
  SPECIAL_SKILL_DAMAGE_MULTIPLIER: 1.5,
} as const

export const SECURITY_HEADERS = {
  X_CONTENT_TYPE_OPTIONS: 'nosniff',
  X_FRAME_OPTIONS: 'DENY',
  X_XSS_PROTECTION: '1; mode=block',
  CSP_DEVELOPMENT: "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; connect-src 'self' https: localhost:*; font-src 'self' data:;",
  CSP_PRODUCTION: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https: blob:; connect-src 'self' https:; font-src 'self' data:;",
  HSTS: 'max-age=31536000; includeSubDomains; preload',
} as const

export const UPLOAD_CONFIG = {
  MAX_FILE_SIZE: 1 * 1024 * 1024,
  ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const,
  ALLOWED_EXTENSIONS: ['jpg', 'jpeg', 'png', 'gif', 'webp'] as const,
  EXT_TO_MIME_TYPE: {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  } as const,
} as const

export const UI_STRINGS = {
  AUTH: {
    TWITCH_LOGIN: 'Twitchでログイン',
    LOADING: '読み込み中...',
    LOGIN_FAILED: 'ログインに失敗しました',
    NETWORK_ERROR: 'ネットワークエラーが発生しました',
    LOGOUT: 'ログアウト',
    REDIRECTING: 'Twitchログインページへ移動中...',
  },

  CARD_MANAGER: {
    TITLE: 'カード管理',
    ADD_NEW_CARD: '新規カード追加',
    EDIT_CARD: 'カードを編集',
    NEW_CARD: '新規カード',
    FORM_LABELS: {
      NAME: 'カード名',
      NAME_PLACEHOLDER: 'カード名',
      IMAGE: '画像 (ファイルまたはURL)',
      IMAGE_URL_PLACEHOLDER: 'または画像URLを入力',
      RARITY: 'レアリティ',
      DROP_RATE: '出現確率',
      DESCRIPTION: '説明',
    },
    FILE_UPLOAD: {
      FORMATS: '対応形式: JPEG, PNG | ',
      MAX_SIZE: (mb: string) => `最大サイズ: ${mb}MB`,
    },
    BUTTONS: {
      SAVE: '保存中...',
      UPDATE: '更新',
      ADD: '追加',
      CANCEL: 'キャンセル',
      EDIT: '編集',
      DELETE: '削除',
    },
    CONFIRMATIONS: {
      DELETE_CARD: 'このカードを削除しますか？',
    },
    MESSAGES: {
      RATE_LIMIT: 'リクエストが多すぎます。しばらく待ってから再試行してください。',
      DELETE_FAILED: 'カード削除に失敗しました',
      DELETE_FAILED_PREFIX: '削除失敗:',
      NETWORK_ERROR_DELETE: 'ネットワークエラーが発生しました。削除をキャンセルしました。',
      OPERATION_FAILED: (msg: string) => `操作失敗: ${msg}`,
      EMPTY_CARDS: 'まだカードがありません。「新規カード追加」から始めましょう。',
      PROBABILITY: '確率:',
      NO_IMAGE: 'No Image',
    },
  },

  COLLECTION: {
    TITLE: 'マイコレクション',
    EMPTY_MESSAGE: {
      LINE1: 'まだカードを持っていません。',
      LINE2: '配信者のチャネルポイントを使ってカードをゲットしましょう！',
    },
    CARD_TYPES: (count: number) => `(${count} 種類)`,
    CARD_COUNT: (count: number) => `x${count}`,
  },

  DASHBOARD: {
    TITLE: 'ダッシュボード',
    STREAMER_SETTINGS: '配信者設定',
    OBS_OVERLAY_URL: 'OBSブラウザソースURL',
    OBS_OVERLAY_DESCRIPTION: 'OBSのブラウザソースにこのURLを設定してください（推奨サイズ: 800x600）',
  },

  BATTLE: {
    TITLE: 'カード対戦',
    VERSUS: 'VS',
    USER_CARD: 'あなたのカード',
    CPU_CARD: 'CPUカード',
    BATTLE_PROGRESS: 'バトル進行',
    BATTLE_LOG: 'バトルログ',
    TURN: 'ターン',
    YOU: 'あなた',
    CPU: 'CPU',
    NO_IMAGE: 'No Image',
  },

  CHANNEL_POINT_SETTINGS: {
    TITLE: 'チャネルポイント設定',
    STATUS: {
      ACTIVE: '接続中',
      PENDING: '確認中',
      ERROR: 'エラー',
      NONE: '未設定',
    },
    MESSAGES: {
      AFFILIATE_REQUIRED: 'チャネルポイントを使用するには、Twitchアフィリエイトまたはパートナーである必要があります。',
      RATE_LIMIT: 'リクエストが多すぎます。しばらく待ってから再試行してください。',
      FETCH_FAILED: '報酬の取得に失敗しました。再度ログインしてください。',
      REWARD_CREATED: '報酬を作成しました',
      ERROR_OCCURRED: 'エラーが発生しました',
      CREATE_REWARD_FAILED: '報酬の作成に失敗しました',
      SAVE_FAILED: '設定の保存に失敗しました',
      SAVE_SUCCESS: '保存しました（EventSub登録完了）',
      EVENTSUB_FAILED: '設定は保存しましたが、EventSub登録に失敗しました。URLが外部からアクセス可能か確認してください。',
    },
    SUCCESS_MESSAGES: [
      '報酬を作成しました',
      '保存しました（EventSub登録完了）',
    ] as const,
    FORM_LABELS: {
      SELECT_REWARD: '使用する報酬を選択',
      NO_REWARDS: 'チャネルポイント報酬がありません。新しく作成しますか？',
      SELECTED: '選択中:',
      ID: 'ID:',
      REWARD_ID: '報酬ID:',
      ALL_REWARDS: '全報酬',
      EVENTSUB_STATUS: 'EventSub ステータス',
      NO_SUBSCRIPTIONS: 'EventSubサブスクリプションがありません。保存ボタンを押して登録してください。',
      LOCAL_TUNNEL_NOTE: '※ ローカル環境ではngrokなどのトンネルが必要です',
    },
    BUTTONS: {
      CREATING: '作成中...',
      CREATE_REWARD: 'TwiCa用報酬を作成（100ポイント）',
      SAVING: '保存中...',
      SAVE: '保存 & EventSub登録',
      REFRESH: '更新',
    },
    OPTIONS: {
      SELECT_REWARD: '-- 報酬を選択 --',
      POINTS: 'ポイント',
      DISABLED: '[無効]',
    },
  },

  COPY_BUTTON: {
    COPIED: 'コピーしました',
    COPY: 'コピー',
  },

  GACHA_HISTORY: {
    TITLE: '最近の獲得情報',
    EMPTY_MESSAGE: 'まだ獲得情報はありません。',
    GOT: (username: string, cardName: string) => `${username} が${cardName} を獲得しました！`,
    GOT_LABEL: ' が ',
    UNKNOWN: 'Unknown',
  },

  STATS: {
    TOTAL_CARDS: '総カード数',
    UNIQUE: 'ユニーク',
    LEGENDARY: 'レジェンダリー',
    EPIC: 'エピック',
    RARE: 'レア',
    COMMON: 'コモン',
  },

  DEVELOPMENT_NOTICE: {
    TEXT: '⚠️ このサービスは現在開発初期段階です。一部の機能が正常に動作しない場合があります。',
  },
} as const
