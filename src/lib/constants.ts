import { logger } from './logger'

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
  CSRF_TOKEN: 'csrf_token',
  // ログイン後にリダイレクトする先のURL（認証フロー用）
  // URL to redirect to after login (for auth flow)
  RETURN_TO: 'twica_return_to',
  // スコープ復元失敗時のガード用Cookie（値はOAuth state）
  // Guard cookie for scope restoration failure (value is the OAuth state)
  SCOPE_RESTORE_FAILED: 'twica_scope_restore_failed',
  // 再認証フロー判定用Cookie（値はOAuth state）
  // Re-auth flow marker cookie (value is the OAuth state)
  REAUTH_STATE: 'twica_reauth_state',
  // Discord OAuth認証フロー用のCSRF state
  // CSRF state for Discord OAuth flow
  DISCORD_AUTH_STATE: 'discord_auth_state',
}

export const API_ROUTES = {
  AUTH_TWITCH_CALLBACK: '/api/auth/twitch/callback',
  AUTH_TWITCH_LOGIN: '/api/auth/twitch/login',
  AUTH_LOGOUT: '/api/auth/logout',
  AUTH_DISCORD_LOGIN: '/api/auth/discord/login',
  AUTH_DISCORD_CALLBACK: '/api/auth/discord/callback',
  AUTH_DISCORD_UNLINK: '/api/auth/discord/unlink',
  AUTH_DISCORD_REFRESH_ROLE: '/api/auth/discord/refresh-role',
}

export const SESSION_CONFIG = {
  MAX_AGE_SECONDS: 7 * 24 * 60 * 60,  // 7 days (session validity)
  MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  // CookieのmaxAgeはセッション有効期限より長く設定する。
  // ログインルートのparseSession()が期限切れCookieからtwitchUserIdを抽出して
  // 追加スコープ（user:write:chat等）を保持するために、この猶予期間が必要。
  // Cookie maxAge is intentionally longer than session validity.
  // The login route's parseSession() relies on the expired cookie to extract twitchUserId
  // and preserve additional scopes (e.g., user:write:chat) during re-login.
  COOKIE_MAX_AGE_SECONDS: 30 * 24 * 60 * 60,  // 30 days (cookie lifetime for scope preservation)
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
} as const;

export const RARITY_GRADIENT_COLORS = {
  common: "from-gray-400 to-gray-600",
  rare: "from-blue-400 to-blue-600",
  epic: "from-purple-400 to-purple-600",
  legendary: "from-yellow-400 to-orange-500",
} as const;

export const RARITY_GLOW = {
  common: "shadow-gray-500/50",
  rare: "shadow-blue-500/50",
  epic: "shadow-purple-500/50",
  legendary: "shadow-yellow-500/50",
} as const;

export const GACHA_COST = parseInt(process.env.GACHA_COST || '100', 10)

export const DEBUG_CONFIG = {
  ALLOWED_HOSTS: ['localhost', '127.0.0.1', '::1'],
  PRODUCTION_ENV: 'production',
} as const

/**
 * Cookieドメインを取得
 * 明示的にドメインを設定せず、ブラウザのデフォルト動作に任せる
 * これにより、Cookieは現在のホストに対して設定され、同一オリジンからのリクエストで自動的に送信される
 */
export function getCookieDomain(): string | undefined {
  // 常に undefined を返し、ブラウザのデフォルト動作に任せる
  // 明示的にドメインを設定すると、サブドメインの扱いやクロスオリジンの問題が発生する可能性がある
  return undefined
}

/**
 * セッションCookieのオプションを取得（ドメイン設定を含む）
 */
export function getSessionCookieOptions(): {
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax'
  path: string
  maxAge: number
  domain?: string
} {
  const domain = getCookieDomain()
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    // セッション有効期限(7日)より長いmaxAge(30日)を使用。
    // getSession()はexpiresAtで有効期限を判定するため、Cookieが長く残っても安全。
    // 期限切れCookieはログイン時のスコープ保持にのみ使用される。
    // Use COOKIE_MAX_AGE_SECONDS (30d) instead of MAX_AGE_SECONDS (7d).
    // getSession() checks expiresAt for session validity, so a longer cookie is safe.
    // Expired cookies are only used for scope preservation during re-login.
    maxAge: SESSION_CONFIG.COOKIE_MAX_AGE_SECONDS,
    ...(domain && { domain }),
  }
}

/**
 * Cookie削除用のオプション（maxAge: 0 で即座に削除）
 */
export function getDeleteCookieOptions(): {
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax'
  path: string
  maxAge: number
  domain?: string
} {
  const domain = getCookieDomain()
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
    ...(domain && { domain }),
  }
}

export const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 60 * 10,
} as const

export const CSRF_CONFIG = {
  TOKEN_LENGTH: 32,
  HEADER_NAME: 'X-CSRF-Token',
  MAX_RETRY_COUNT: 3,
  RETRY_DELAY_MS: 50,
  ALLOW_LOCAL_ORIGINS: process.env.CSRF_ALLOW_ALL_LOCAL === 'true' && process.env.NODE_ENV === 'development',
  ALLOWED_ORIGINS: (() => {
    const origins: string[] = []
    // Cloudflare Workers のローカル開発サーバーはポート 8787 を使用
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:8787'

    try {
      const url = new URL(appUrl)
      const port = url.port || (url.protocol === 'https:' ? '443' : '80')

      origins.push(appUrl)

      // Vercel preview/production deployments
      if (process.env.VERCEL_URL) {
        origins.push(`https://${process.env.VERCEL_URL}`)
      }

      // Vercel branch deployments (e.g., project-git-branch-user.vercel.app)
      if (process.env.VERCEL_BRANCH_URL) {
        origins.push(`https://${process.env.VERCEL_BRANCH_URL}`)
      }

      // 開発環境では localhost と 127.0.0.1 を追加
      if (process.env.NODE_ENV === 'development') {
        origins.push(`http://127.0.0.1:${port}`)
        origins.push(`http://[::1]:${port}`)
        // Cloudflare Workers のローカル開発サーバーのデフォルトポート
        origins.push('http://localhost:8787')
        origins.push(`http://localhost:${port}`)
      }
    } catch (error) {
      logger.warn('Failed to parse NEXT_PUBLIC_APP_URL for CSRF origins:', error)
      origins.push(appUrl)
    }

    return origins.filter((origin, index, arr) => arr.indexOf(origin) === index) as string[]
  })(),
} as const

export const ERROR_MESSAGES = {
  // Authentication errors
  UNAUTHORIZED: 'Unauthorized',
  NOT_AUTHENTICATED: 'Not authenticated',
  FORBIDDEN: 'Forbidden',
  CSRF_TOKEN_INVALID: 'Invalid or missing CSRF token',
  CSRF_TOKEN_MISSING: 'CSRF token is required for this request',

  // Request validation errors
  MISSING_REQUIRED_FIELDS: 'Missing required fields',
  INVALID_REQUEST: 'Invalid request',
  INVALID_CARD_ID: 'Invalid card ID',
  USER_CARD_ID_REQUIRED: 'userCardId is required',
  STREAMER_ID_REQUIRED: 'streamerId is required',
  STREAMER_ID_MISSING: 'Missing streamerId',
  DROP_RATE_INVALID: 'Drop rate must be a number between 0 and 1',
  CONTENT_TYPE_MISSING: 'Content-Type header is required',
  CONTENT_TYPE_INVALID: 'Invalid Content-Type. Expected {expected}, received {received}',
  CARD_NAME_REQUIRED: 'Card name is required',
  CARD_NAME_TOO_LONG: 'Card name must be between 1 and 100 characters',
  DESCRIPTION_TOO_LONG: 'Description must not exceed 500 characters',
  INVALID_IMAGE_URL: 'Invalid image URL format',
  INVALID_RARITY: 'Invalid rarity value. Must be one of: common, rare, epic, legendary',

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

  // Sound upload errors
  // 効果音アップロードエラー
  INVALID_SOUND_FILE_TYPE: 'Invalid sound file type. Only MP3, WAV, WebM, and OGG are allowed',
  SOUND_FILE_SIZE_EXCEEDED: 'Sound file size exceeds 1MB limit',
  SOUND_CONTENT_MISMATCH: 'Sound file content does not match extension',

  // Support code errors
  // 支援コード関連エラー
  INVALID_SUPPORT_CODE: 'Invalid support code',
  SUPPORT_CODE_REVOKED: 'This support code has been revoked',
  SUPPORT_CODE_ROTATING: 'This support code is no longer accepting new activations',
  SUPPORT_CODE_ALREADY_ACTIVATED: 'You have already activated this code',
  SUPPORT_CODE_REQUIRED: 'Support code is required',
  SUPPORT_CODE_TOO_LONG: 'Support code is too long',
  FANBOX_ID_TOO_LONG: 'FANBOX ID is too long',
  // プランダウングレード等でストレージ超過時のエラー
  PLAN_OVER_LIMIT: 'ストレージ容量を超過しています。プランをアップグレードするか、画像を削除してください。',

  // Support inquiry errors
  INQUIRY_NOT_FOUND: 'Inquiry not found',
  INQUIRY_CLOSED: 'This inquiry is closed and cannot receive replies',
  INQUIRY_SUBJECT_REQUIRED: 'Subject is required',
  INQUIRY_SUBJECT_TOO_LONG: 'Subject must not exceed 200 characters',
  INQUIRY_BODY_REQUIRED: 'Body is required',
  INQUIRY_BODY_TOO_LONG: 'Body must not exceed 2000 characters',
  INQUIRY_INVALID_CATEGORY: 'Invalid category. Must be one of: bug, feature, other',
  INQUIRY_SUPPORTER_ONLY: 'This feature is available for supporters only',

  // General errors
  INTERNAL_ERROR: 'Internal server error',
  OPERATION_FAILED: 'Operation failed',

  // Additional authentication errors
  TWITCH_TOKEN_REQUIRED: 'Twitch連携が必要です。再ログインしてください。',
  TWITCH_TOKEN_REFRESH_FAILED: 'Twitchトークンの更新に失敗しました。再ログインしてください。',

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
  // Development CSP includes 'unsafe-eval' for Next.js fast refresh and dev tools
  // 開発用CSPにはNext.jsのfast refreshと開発ツールのため'unsafe-eval'を含む
  // media-src: R2バケットからの効果音再生を許可
  // Cloudflare Insights (static.cloudflareinsights.com) のビーコンスクリプトを許可
  // Allow Cloudflare Insights beacon script from static.cloudflareinsights.com
  CSP_DEVELOPMENT: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https:; connect-src 'self' https: localhost:* wss:; font-src 'self' data:; worker-src 'self' blob:;",
  CSP_PRODUCTION: "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https:; connect-src 'self' https: wss:; font-src 'self' data:; worker-src 'self' blob:;",
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
  // Storage limits
  // ストレージ制限
  USER_STORAGE_LIMIT: 10 * 1024 * 1024, // 10MB per user (increased from 5MB)
  // Global storage limit disabled - set to very large value
  // グローバルストレージ制限を撤廃 - 非常に大きな値を設定
  GLOBAL_STORAGE_LIMIT: Number.MAX_SAFE_INTEGER, // No global limit
} as const

/**
 * 効果音アップロード設定
 * ガチャ時に再生される効果音のアップロード制限
 * 画像アップロードとは別の設定で管理
 */
export const SOUND_UPLOAD_CONFIG = {
  // ファイルサイズ上限: 1MB（効果音は短時間の音声を想定）
  MAX_FILE_SIZE: 1 * 1024 * 1024,
  // 許可する音声MIMEタイプ
  ALLOWED_TYPES: ['audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg'] as const,
  // 許可する拡張子
  ALLOWED_EXTENSIONS: ['mp3', 'wav', 'webm', 'ogg'] as const,
  // 拡張子からMIMEタイプへのマッピング
  EXT_TO_MIME_TYPE: {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    webm: 'audio/webm',
    ogg: 'audio/ogg',
  } as const,
} as const

/**
 * 選挙キャンペーン設定
 * 期間限定で「選挙行ったよ/行こうかな」ボタンを押すとストレージ容量が+5MBされるキャンペーン
 * キャンペーン期間外はボタンが非表示になる
 *
 * - 投票済証の提示など証拠は不要（自己申告）
 * - 選挙権のない方でも、将来得ることがあれば投票行こうかなと思えば誰でもOK
 * - 投票率向上を願うキャンペーン（特定の政党・候補者を応援するものではない）
 */
export const VOTE_CAMPAIGN_CONFIG = {
  // キャンペーン開始日時（JST 2026-02-08 00:00:00 = UTC 2026-02-07 15:00:00）
  START_DATE: new Date('2026-02-07T15:00:00Z'),
  // キャンペーン終了日時（JST 2026-02-15 23:59:59 = UTC 2026-02-15 14:59:59）
  END_DATE: new Date('2026-02-15T14:59:59Z'),
  // ボーナス容量（MB）
  BONUS_MB: 5,
  // DB記録用の識別子
  TYPE: 'campaign' as const,
  // WARNING: MEMOはUNIQUE制約 (streamer_id, type, memo) の一部。変更すると同一ユーザーへの二重適用が発生する
  MEMO: '2026選挙応援' as const,
} as const

/** localStorageキー: ユーザーが投票キャンペーンパネルを「今後表示しない」にした場合に 'true' を保存 */
export const VOTE_CAMPAIGN_DISMISS_KEY = 'vote-campaign-dismissed'

/**
 * 支援プラン設定
 * コード入力のバリデーション制限値
 */
export const PLAN_CONFIG = {
  CODE_MAX_LENGTH: 64,
  FANBOX_ID_MAX_LENGTH: 100,
} as const

export const STORAGE_LIMIT_MESSAGES = {
  // User limit message: increased to 10MB
  // ユーザー制限メッセージ: 10MBに増加
  USER_LIMIT_REACHED: '画像のアップロード上限は現在一アカウントにつき10MBです。上限を超える場合は、既存の画像を削除してから再度お試しください。',
  // Global limit message: kept for backwards compatibility but no longer used
  // グローバル制限メッセージ: 後方互換性のために残すが使用されない
  GLOBAL_LIMIT_REACHED: '画像のアップロード上限に達しました。',
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
    TITLE: 'カード引き換え設定',
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
      SELECT_REWARD: 'カード引き換えに使用するチャネルポイント報酬を選択',
      NO_REWARDS: 'チャネルポイント報酬がありません。新しく作成しますか？',
      SELECTED: '選択中:',
      ID: 'ID:',
      REWARD_ID: '報酬ID:',
      ALL_REWARDS: '全報酬',
      EVENTSUB_STATUS: 'EventSub ステータス',
      NO_SUBSCRIPTIONS: 'EventSubサブスクリプションがありません。保存ボタンを押して登録してください。',
      LOCAL_TUNNEL_NOTE: '※ EventSubはローカル環境では利用できません',
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
    TEXT: '⚠️ このサービスはβテスト中です。一部の機能が正常に動作しない場合があります。',
  },

  // Dashboard navigation and page strings
  // ダッシュボードナビゲーションとページの文字列
  DASHBOARD_NAV: {
    OVERVIEW: '概要',
    CARD_MANAGEMENT: 'カード管理',
    SETTINGS: '配信設定',
    COLLECTION: 'マイコレクション',
  },

  // Dashboard overview page strings
  // ダッシュボード概要ページの文字列
  DASHBOARD_OVERVIEW: {
    TITLE: 'ダッシュボード',
    RECENT_CARDS: '最近のカード',
    VIEW_ALL_CARDS: 'すべてのカードを見る',
    VIEW_ALL_COLLECTION: 'コレクションをすべて見る',
    VIEW_SETTINGS: '配信設定を開く',
    COLLECTION_SUMMARY: 'コレクション概要',
    STREAMER_INFO: '配信者機能について',
    STREAMER_INFO_TEXT: 'チャネルポイント報酬やカード管理機能を使用するには、Twitchアフィリエイトまたはパートナーである必要があります。',
    NO_CARDS_YET: 'まだカードがありません',
    CREATE_FIRST_CARD: '最初のカードを作成',
    QUICK_LINKS: 'クイックリンク',
  },

  // Card view toggle strings
  // カード表示切り替えの文字列
  CARD_VIEW: {
    THUMBNAIL: 'サムネイル',
    LIST: 'リスト',
  },

  // Pagination strings
  // ページネーションの文字列
  PAGINATION: {
    PREVIOUS: '前へ',
    NEXT: '次へ',
    PAGE_INFO: (current: number, total: number) => `${current} / ${total}`,
    ITEMS_PER_PAGE: '件表示',
  },

  // Settings page strings
  // 設定ページの文字列
  SETTINGS_PAGE: {
    TITLE: '配信設定',
    DESCRIPTION: 'OBSオーバーレイとチャネルポイント報酬の設定を行います。',
  },

  // Cards page strings
  // カードページの文字列
  CARDS_PAGE: {
    TITLE: 'カード管理',
    DESCRIPTION: 'カードの作成、編集、削除を行います。',
  },

  // Collection page strings
  // コレクションページの文字列
  COLLECTION_PAGE: {
    TITLE: 'マイコレクション',
    DESCRIPTION: '獲得したカードを確認できます。',
  },
} as const
