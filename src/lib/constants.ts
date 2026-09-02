import { logger } from './logger'

export const BROADCASTER_TYPE = {
  AFFILIATE: 'affiliate' as const,
  PARTNER: 'partner' as const,
  NONE: '' as const,
}

export const TWITCH_SUBSCRIPTION_TYPE = {
  CHANNEL_POINTS_REDEMPTION_ADD: 'channel.channel_points_custom_reward_redemption.add' as const,
  CHANNEL_RAID: 'channel.raid' as const,
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
  // BOTアカウント連携フロー判定用Cookie（値はOAuth state）
  // BOT account OAuth flow marker (value is OAuth state)
  BOT_AUTH_STATE: 'twica_bot_auth_state',
  // ログアウト後のスコープ復元用最小Cookie（twitchUserIdのみ格納）
  // 全セッションデータの代わりにtwitchUserIdだけを保持し、
  // loginルートが追加スコープ復元に使用する
  // Minimal cookie for scope restoration after logout (stores only twitchUserId).
  // Replaces full session cookie to minimize retained data.
  SCOPE_RESTORE_USER_ID: 'twica_scope_restore_uid',
  // スコープ自動復元リダイレクト用Cookie（値はOAuth state）
  // Cookie消失等でloginルートがスコープ復元できなかった場合、callbackが不足スコープを含む
  // OAuthフローに自動リダイレクトする。2回目callbackでこのCookieを検出して乖離チェックをスキップ。
  // Auto scope recovery redirect marker (value is OAuth state).
  // When login route cannot restore scopes (cookie loss etc.), callback auto-redirects to
  // a new OAuth flow with missing scopes. Second callback detects this cookie to skip divergence check.
  SCOPE_RECOVERY: 'twica_scope_recovery',
}

export const API_ROUTES = {
  AUTH_TWITCH_CALLBACK: '/api/auth/twitch/callback',
  AUTH_TWITCH_LOGIN: '/api/auth/twitch/login',
  AUTH_LOGOUT: '/api/auth/logout',
  AUTH_BOT_CALLBACK: '/api/auth/bot/callback',
}

export const SESSION_CONFIG = {
  MAX_AGE_SECONDS: 7 * 24 * 60 * 60,  // 7 days (session validity)
  MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  // CookieのmaxAgeはセッション有効期限より長く設定する。
  // ログアウト後のSCOPE_RESTORE_USER_ID Cookieもこの期間保持され、
  // loginルートが追加スコープ（user:write:chat等）の復元に使用する。
  // Cookie maxAge is intentionally longer than session validity.
  // SCOPE_RESTORE_USER_ID cookie is kept for this duration so the login route
  // can preserve additional scopes (e.g., user:write:chat) on re-login.
  COOKIE_MAX_AGE_SECONDS: 30 * 24 * 60 * 60,  // 30 days (cookie lifetime for scope preservation)
  COOKIE_PATH: '/',
}

// レアリティ名（rarity_weights のキー / cards.rarity / custom_rarities）の
// 共通検証プリミティブ。クライアント(モーダル)とサーバー(API)で同一規則を使う。
// レアリティ名の最大長。DB側のレアリティ列(varchar)と整合する保守的な上限。
export const MAX_RARITY_KEY_LENGTH = 40;
// 1配信者あたりのカスタムレアリティ数の上限。DB(00049 の CHECK)と整合させる。
export const MAX_CUSTOM_RARITIES = 50;
// 1配信者あたりの事前登録カードパック数の上限。DB(00062 の CHECK)と整合させる。
export const MAX_CARD_PACK_NAMES = 50;
// pack_rarity_weights のエントリ数上限。事前登録パック上限(50) + __default__(1)。
// DB(00065 の check_pack_rarity_weights_values)と整合させる。Issue #578
export const MAX_PACK_RARITY_WEIGHTS_ENTRIES = 51;
// 制御文字(C0 U+0000-U+001F・DEL U+007F・C1 U+0080-U+009F)。
// 表示崩れや不可視キー注入を防ぐため禁止。
export const RARITY_CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F]/;
// Bidi override/embedding/isolate 文字。UI上で他キーへのなりすましを防ぐため禁止。
export const RARITY_BIDI_OVERRIDE_REGEX = /[\u202A-\u202E\u2066-\u2069]/;

export const RARITIES = [
  { value: "common", label: "コモン", color: "bg-gray-500" },
  { value: "rare", label: "レア", color: "bg-blue-500" },
  { value: "epic", label: "エピック", color: "bg-purple-500" },
  { value: "legendary", label: "レジェンダリー", color: "bg-yellow-500" },
] as const;

// レアリティ別デフォルト排出確率（%）。自動モード有効化時の初期値。
export const DEFAULT_RARITY_WEIGHTS: Record<string, number> = {
  common: 70,
  rare: 20,
  epic: 8,
  legendary: 2,
};

export const RARITY_ORDER = ["legendary", "epic", "rare", "common"];

export const RARITY_COLORS: Record<string, string> = {
  legendary: "bg-yellow-500",
  epic: "bg-purple-500",
  rare: "bg-blue-500",
  common: "bg-gray-500",
};

export const RARITY_GRADIENT_COLORS: Record<string, string> = {
  common: "from-gray-400 to-gray-600",
  rare: "from-blue-400 to-blue-600",
  epic: "from-purple-400 to-purple-600",
  legendary: "from-yellow-400 to-orange-500",
};

export const RARITY_GLOW: Record<string, string> = {
  common: "shadow-gray-500/50",
  rare: "shadow-blue-500/50",
  epic: "shadow-purple-500/50",
  legendary: "shadow-yellow-500/50",
};

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
  // CSRF 検証は HttpOnly Cookie + Origin/Referer 方式（src/lib/csrf.ts 参照）。
  // ヘッダ経由のトークン送信は採用していないため HEADER_NAME は意図的に存在しない。
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

export const CARD_DESCRIPTION_MAX_CHARACTERS = 500
export const TWITCH_CHAT_MESSAGE_MAX_CHARACTERS = 500

export const ERROR_MESSAGES = {
  // Authentication errors
  UNAUTHORIZED: 'Unauthorized',
  NOT_AUTHENTICATED: 'Not authenticated',
  FORBIDDEN: 'Forbidden',
  CSRF_TOKEN_INVALID: 'Invalid or missing CSRF token',
  CSRF_TOKEN_MISSING: 'CSRF token is required for this request',
  CSRF_ORIGIN_NOT_TRUSTED: 'リクエストのオリジンが許可されていません',

  // Request validation errors
  MISSING_REQUIRED_FIELDS: 'Missing required fields',
  INVALID_REQUEST: 'Invalid request',
  STREAMER_ID_REQUIRED: 'streamerId is required',
  STREAMER_ID_MISSING: 'Missing streamerId',
  DROP_RATE_INVALID: 'Drop rate must be a number between 0 and 1',
  INTRA_RARITY_WEIGHT_INVALID: 'Intra-rarity weight must be a positive number',
  // Issue #393: a reward was bound to a pack that has no active cards to draw.
  COLLECTION_NOT_FOUND: 'No active cards belong to the selected card pack',
  // Issue #393 redesign: a card/reward tried to bind a NEW pack name that isn't
  // in the streamer's pre-defined card_pack_names list (distinct from
  // COLLECTION_NOT_FOUND, which is about an empty-but-registered pack).
  COLLECTION_NOT_REGISTERED: 'The selected card pack has not been registered. Add it in pack management first.',
  // Issue #554: PATCH /api/cards/collections (pack rename) returns this when
  // the `rename_card_pack` RPC is not deployed yet (deploy-window fallback,
  // mirrors the cardPackNamesSkippedDeployWindow pattern used elsewhere).
  PACK_RENAME_NOT_READY: 'Pack renaming is not available yet. Please try again shortly.',
  CONTENT_TYPE_MISSING: 'Content-Type header is required',
  CONTENT_TYPE_INVALID: 'Invalid Content-Type. Expected {expected}, received {received}',
  CARD_NAME_REQUIRED: 'Card name is required',
  CARD_NAME_TOO_LONG: 'Card name must be between 1 and 100 characters',
  DESCRIPTION_TOO_LONG: `Description must not exceed ${CARD_DESCRIPTION_MAX_CHARACTERS} characters`,
  INVALID_IMAGE_URL: 'Invalid image URL format',
  INVALID_RARITY: 'Invalid rarity value. Use 1-40 non-control characters.',

  // Rate limit errors
  RATE_LIMIT_EXCEEDED: 'Too many requests. Please try again later.',

  // Resource errors
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
  PLAN_OVER_LIMIT: 'ストレージ容量を超過しています。支援特典をアップグレードするか、画像を削除してください。',
  // 支援プランが必要な機能へのアクセス拒否
  PLAN_UPGRADE_REQUIRED: 'この機能は助力プラン以上が必要です',

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

  // Additional authentication errors
  TWITCH_TOKEN_REQUIRED: 'Twitch連携が必要です。再ログインしてください。',

  // Additional request validation errors
  MISSING_REWARD_ID: 'Missing rewardId',

  // EventSub errors
  INVALID_SIGNATURE: 'Invalid signature',
  UNKNOWN_MESSAGE_TYPE: 'Unknown message type',

  // Twitch API errors

  // Debug errors
  DEBUG_ENDPOINT_NOT_AVAILABLE: 'Debug endpoint not available in production',
  DEBUG_ENDPOINT_NOT_AUTHORIZED: 'Debug endpoint only accessible from localhost',
} as const

export const SECURITY_HEADERS = {
  X_CONTENT_TYPE_OPTIONS: 'nosniff',
  X_FRAME_OPTIONS: 'DENY',
  // 旧 UA の XSS auditor を明示的に無効化（auditor 自体を悪用する既知手法への対策。
  // 現行ブラウザは auditor 自体が廃止済みで、XSS 対策は CSP が担う）。
  X_XSS_PROTECTION: '0',
  // CSP 文字列は buildCsp()（src/lib/security-headers.ts）の共通テーブルからのみ
  // 組み立てる。ここに定数を置くと buildCsp と乖離し、テストが自己参照になるため
  // 定数は持たない（乖離防止は directive 単位のテストで担保）。
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
  // グローバル上限が実質無制限(Number.MAX_SAFE_INTEGER)だったため、認証さえ
  // 通れば無制限に書き込める状態だった (#832)。ユーザー上限(10MB)+全プラン最大の
  // ストレージボーナス(500MB, plan-constants.ts)を踏まえても、現在の運用規模で
  // 現実的にありえない50GBを運用上の上限として設定する。unreachableではなく実際に
  // 効くガードなので、規模が拡大したら見直すこと。
  GLOBAL_STORAGE_LIMIT: 50 * 1024 * 1024 * 1024, // 50GB operational cap
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

// API互換用の日本語フォールバック文言。公式UIは upload の code /
// storage-status の構造化フラグを使って t() で表示文言を解決するため、
// ここでは外部・未知クライアント向けの互換文字列を維持する（#835 / #1345）。
export const STORAGE_LIMIT_MESSAGES = {
  // User limit message: increased to 10MB
  // ユーザー制限メッセージ: 10MBに増加
  USER_LIMIT_REACHED: '画像のアップロード上限は現在一アカウントにつき10MBです。上限を超える場合は、既存の画像を削除してから再度お試しください。',
  GLOBAL_LIMIT_REACHED: '画像のアップロード上限に達しました。',
} as const
