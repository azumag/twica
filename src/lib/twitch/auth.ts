import { getEnvVar } from '@/lib/env-validation'
import { logger } from '@/lib/logger.server'
import { AUTH_SCOPES } from './scopes'

const TWITCH_AUTH_URL = 'https://id.twitch.tv/oauth2/authorize'
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const TWITCH_API_URL = 'https://api.twitch.tv/helix'

// Twitch の refresh token はローテーションされ得るため、同じ POST を無制限に
// 再送してはいけない。ここでは一時的な gateway/network 障害だけを、短く上限付きで
// 再試行する。Retry-After を優先し、無い場合は同時復旧時の集中を避ける full jitter
// を使う。認可コード交換は単回使用のため、このヘルパーを意図的に使わない。
const REFRESH_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 522, 523, 524])
const MAX_REFRESH_ATTEMPTS = 3
const MAX_RETRY_AFTER_MS = 2_000
const RETRY_BASE_DELAY_MS = 100

type RetryAfter = { kind: 'missing' | 'invalid' } | { kind: 'valid'; delayMs: number }

const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const RFC850_DATE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/
const ASCTIME_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?: (\d{2})|  (\d)) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
}
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Sunday: 0,
  Mon: 1, Monday: 1,
  Tue: 2, Tuesday: 2,
  Wed: 3, Wednesday: 3,
  Thu: 4, Thursday: 4,
  Fri: 5, Friday: 5,
  Sat: 6, Saturday: 6,
}

interface HttpDateParts {
  weekday: string
  day: number
  month: number
  year: number
  hour: number
  minute: number
  second: number
}

function toUtcTimestamp(parts: HttpDateParts, checkWeekday = true): number | null {
  if (
    parts.day < 1 || parts.day > 31
    || parts.hour < 0 || parts.hour > 23
    || parts.minute < 0 || parts.minute > 59
    // RFC 5322由来のHTTP-dateはleap secondの60だけを追加で許容する。
    || parts.second < 0 || parts.second > 60
  ) {
    return null
  }

  const normalizedSecond = Math.min(parts.second, 59)
  const date = new Date(0)
  date.setUTCFullYear(parts.year, parts.month, parts.day)
  date.setUTCHours(parts.hour, parts.minute, normalizedSecond, 0)

  // Date は31 Feb等を翌月へ正規化するため、全componentをround-tripして拒否する。
  if (
    date.getUTCFullYear() !== parts.year
    || date.getUTCMonth() !== parts.month
    || date.getUTCDate() !== parts.day
    || date.getUTCHours() !== parts.hour
    || date.getUTCMinutes() !== parts.minute
    || date.getUTCSeconds() !== normalizedSecond
    || (checkWeekday && date.getUTCDay() !== WEEKDAY_INDEX[parts.weekday])
  ) {
    return null
  }

  return date.getTime() + (parts.second === 60 ? 1_000 : 0)
}

function parseHttpDate(value: string, now: number): number | null {
  const imf = IMF_FIXDATE.exec(value)
  if (imf) {
    return toUtcTimestamp({
      weekday: imf[1],
      day: Number(imf[2]),
      month: MONTH_INDEX[imf[3]],
      year: Number(imf[4]),
      hour: Number(imf[5]),
      minute: Number(imf[6]),
      second: Number(imf[7]),
    })
  }

  const rfc850 = RFC850_DATE.exec(value)
  if (rfc850) {
    const nowDate = new Date(now)
    const currentYear = nowDate.getUTCFullYear()
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850[4])
    // 2桁年は現在を中心とした100年間へ置く。さらに候補timestampが厳密に
    // 50年超未来なら、RFC 9110 §5.6.7どおり直近の同じ下2桁の過去年へ戻す。
    if (year < currentYear - 50) year += 100
    const parts: HttpDateParts = {
      weekday: rfc850[1],
      day: Number(rfc850[2]),
      month: MONTH_INDEX[rfc850[3]],
      year,
      hour: Number(rfc850[5]),
      minute: Number(rfc850[6]),
      second: Number(rfc850[7]),
    }
    const candidate = toUtcTimestamp(parts, false)
    if (candidate === null) return null
    const fiftyYearsFromNow = new Date(now)
    fiftyYearsFromNow.setUTCFullYear(currentYear + 50)
    if (candidate > fiftyYearsFromNow.getTime()) {
      parts.year -= 100
    }
    return toUtcTimestamp(parts)
  }

  const asctime = ASCTIME_DATE.exec(value)
  if (asctime) {
    return toUtcTimestamp({
      weekday: asctime[1],
      month: MONTH_INDEX[asctime[2]],
      day: Number(asctime[3] ?? asctime[4]),
      hour: Number(asctime[5]),
      minute: Number(asctime[6]),
      second: Number(asctime[7]),
      year: Number(asctime[8]),
    })
  }

  return null
}

function parseRetryAfter(value: string | null, now = Date.now()): RetryAfter {
  if (!value) return { kind: 'missing' }
  // RFC 9110 §10.2.3 の delay-seconds は 1*DIGIT。小数・符号付き値は
  // Number() なら通るが仕様上は不正なので、HTTP-date の解析へ回す。
  if (/^\d+$/.test(value)) {
    const seconds = Number(value)
    return Number.isSafeInteger(seconds)
      ? { kind: 'valid', delayMs: seconds * 1_000 }
      : { kind: 'invalid' }
  }
  // Date.parse はRFC外の値・存在しない日付を正規化し、RFC850の2桁年規則も
  // 実装依存になる。3形式を明示parseし、曜日/calendar/50年規則まで検証する。
  const retryAt = parseHttpDate(value, now)
  return retryAt === null
    ? { kind: 'invalid' }
    : { kind: 'valid', delayMs: Math.max(0, retryAt - now) }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function postRefreshToken(body: URLSearchParams): Promise<Response> {
  for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(TWITCH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      if (response.ok || !REFRESH_RETRYABLE_STATUSES.has(response.status) || attempt === MAX_REFRESH_ATTEMPTS - 1) {
        return response
      }

      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
      // Retry-After は「最低限待つ時間」であり、ローカル上限へ丸めて早く再送すると
      // RFC 9110 の意味を破る。上限を超える場合はこのリクエスト内では再送せず、
      // 呼び出し元へ一時失敗を返して次の通常リクエストに委ねる。
      if (retryAfter.kind === 'valid' && retryAfter.delayMs > MAX_RETRY_AFTER_MS) {
        logger.warn('Twitch token refresh Retry-After exceeds local retry window', {
          status: response.status,
          retryAfterMs: retryAfter.delayMs,
        })
        return response
      }
      const cap = Math.min(MAX_RETRY_AFTER_MS, RETRY_BASE_DELAY_MS * 2 ** attempt)
      const delay = retryAfter.kind === 'valid'
        ? retryAfter.delayMs
        : Math.floor(Math.random() * (cap + 1))
      // 本文をログに出さず、再送前に破棄する。Twitch の失敗応答を接続上に滞留させない。
      await response.text()
      logger.warn('Twitch token refresh transient failure; retrying', { status: response.status, attempt: attempt + 1, delay })
      await wait(delay)
    } catch {
      if (attempt === MAX_REFRESH_ATTEMPTS - 1) {
        throw new TwitchTokenRefreshError()
      }
      const cap = Math.min(MAX_RETRY_AFTER_MS, RETRY_BASE_DELAY_MS * 2 ** attempt)
      const delay = Math.floor(Math.random() * (cap + 1))
      logger.warn('Twitch token refresh network failure; retrying', { attempt: attempt + 1, delay })
      await wait(delay)
    }
  }

  // ループは常に return/throw するが、型検査上の到達不能分岐を明示する。
  throw new TwitchTokenRefreshError()
}

export interface TwitchUser {
  id: string
  login: string
  display_name: string
  profile_image_url: string
  email?: string
  broadcaster_type: string // 'affiliate' | 'partner' | ''
}

export interface TwitchTokens {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  scope: string[]
}

function isTwitchTokens(value: unknown): value is TwitchTokens {
  if (!value || typeof value !== 'object') return false
  const tokens = value as Record<string, unknown>
  return typeof tokens.access_token === 'string'
    && tokens.access_token.length > 0
    && typeof tokens.refresh_token === 'string'
    && tokens.refresh_token.length > 0
    && typeof tokens.expires_in === 'number'
    && Number.isFinite(tokens.expires_in)
    && tokens.expires_in >= 0
    && typeof tokens.token_type === 'string'
    && tokens.token_type.length > 0
    && Array.isArray(tokens.scope)
    && tokens.scope.every(scope => typeof scope === 'string')
}

async function parseTwitchTokens(
  response: Response,
  createSafeError: () => Error,
): Promise<TwitchTokens> {
  try {
    // Response.json() の SyntaxError は不正JSONの本文断片を message に含める実装がある。
    // token endpoint は入力値や資格情報を反射し得るため、本文はローカル変数内だけで
    // JSON.parse し、失敗時は元例外を捨てた固定エラーへ置換する。
    const parsed: unknown = JSON.parse(await response.text())
    if (isTwitchTokens(parsed)) return parsed
  } catch {
    // JSON/stream の元例外は Error.cause にも保持しない。永続 writer まで届くのは
    // createSafeError() が生成する status/kind だけのエラーでなければならない。
  }
  throw createSafeError()
}

export class TwitchOAuthTokenExchangeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly isInvalidAuthorizationCode: boolean
  ) {
    super(message)
    this.name = 'TwitchOAuthTokenExchangeError'
  }
}

/**
 * Token endpoint の失敗本文はプロバイダが入力値を反射する可能性があるため保持しない。
 * status のみを公開し、Error.message / logger / errors context / BOT last_error のどこにも
 * access token・refresh token・client secret が流れない境界を型として固定する。
 */
export class TwitchTokenRefreshError extends Error {
  constructor(
    public readonly status?: number,
    public readonly retryable = status === undefined || REFRESH_RETRYABLE_STATUSES.has(status),
    public readonly kind: 'network' | 'http' | 'invalid_response' = status === undefined ? 'network' : 'http',
  ) {
    super(kind === 'invalid_response'
      ? 'Failed to refresh authentication token: invalid response'
      : status === undefined
        ? 'Failed to refresh authentication token: network error'
        : `Failed to refresh authentication token: ${status}`)
    this.name = 'TwitchTokenRefreshError'
  }
}

function isInvalidAuthorizationCodeResponse(status: number, errorBody: string): boolean {
  return status === 400 && /invalid authorization code/i.test(errorBody)
}

export function isInvalidAuthorizationCodeError(error: unknown): boolean {
  return error instanceof TwitchOAuthTokenExchangeError && error.isInvalidAuthorizationCode
}

// スコープ定数は `@/lib/twitch/scopes` から import する。
// auth.ts はサーバー専用（env-validation への依存あり）だが、scopes.ts は
// クライアント安全なため、client component は scopes.ts から直接 import する。
// Scope constants live in `@/lib/twitch/scopes`. This module (auth.ts) is
// server-only via env-validation, while scopes.ts is client-safe, so client
// components must import scope constants from scopes.ts directly.

/**
 * Twitch OAuth認証URLを生成
 * @param redirectUri - コールバックURL
 * @param state - CSRF防止用のstate値
 * @param additionalScopes - 追加で要求するスコープ（オプション機能用）
 * @param options - 追加オプション
 * @param options.forceVerify - force_verifyの明示的制御。
 *   trueまたは未指定(additionalScopes有り時): Twitchの同意画面を強制表示。
 *   false: 同意画面を強制しない（通常ログインで既存スコープを保持する場合に使用）。
 * @returns Twitch認証ページのURL
 */
export function getTwitchAuthUrl(
  redirectUri: string,
  state: string,
  additionalScopes?: string[],
  options?: { forceVerify?: boolean }
): string {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!

  // デフォルトスコープと追加スコープを結合
  // Combine default scopes with additional scopes
  let scopes = AUTH_SCOPES
  if (additionalScopes && additionalScopes.length > 0) {
    scopes = `${AUTH_SCOPES} ${additionalScopes.join(' ')}`
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    state: state,
  })

  // force_verifyの制御:
  // - options.forceVerifyがfalseなら同意画面を強制しない（既存スコープ保持時）
  // - options.forceVerifyがtrueまたは未指定でadditionalScopesがある場合は強制表示
  // Control force_verify:
  // - If options.forceVerify is explicitly false, skip (preserving existing scopes on login)
  // - If true or unset with additionalScopes, force consent screen for new scope grants
  const shouldForceVerify = options?.forceVerify === false
    ? false
    : (additionalScopes && additionalScopes.length > 0)

  if (shouldForceVerify) {
    params.set('force_verify', 'true')
  }

  return `${TWITCH_AUTH_URL}?${params.toString()}`
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<TwitchTokens> {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
  const clientSecret = getEnvVar('TWITCH_CLIENT_SECRET', true)!

  const response = await fetch(TWITCH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    const invalidAuthorizationCode = isInvalidAuthorizationCodeResponse(response.status, errorBody)

    if (invalidAuthorizationCode) {
      // OAuth code is single-use and short-lived; callback は再送せず新しい認可を求める。
      // 利用者操作で起こり得る失敗なので warning に留める。
      logger.warn('Token exchange rejected: invalid or expired authorization code', { status: response.status })
    } else {
      // callback 側の handleAuthError が await reportAuthError で永続化する。
      // ここで logger.error を使うと logger の自動永続化と二重になり #810/#811 の
      // 同一障害 issue を作るため、診断用コンソール出力だけに留める。
      logger.warn('Token exchange failed:', { status: response.status })
    }
    // Token endpoint 本文は入力値・資格情報を反射し得るため、拒否理由そのものは
    // Errorへ含めずstatusと安全な分類だけをcallbackのhandleAuthErrorへ渡す。
    throw new TwitchOAuthTokenExchangeError(
      `Authentication failed: ${response.status}`,
      response.status,
      invalidAuthorizationCode
    )
  }

  return parseTwitchTokens(
    response,
    () => new TwitchOAuthTokenExchangeError(
      'Authentication failed: invalid token response',
      response.status,
      false,
    ),
  )
}

export async function getTwitchUser(accessToken: string): Promise<TwitchUser> {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!

  const response = await fetch(`${TWITCH_API_URL}/users`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': clientId,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    logger.error('Failed to get Twitch user:', { status: response.status, errorBody })
    // Twitch APIのエラー詳細をメッセージに含め、呼び出し元で原因を特定可能にする
    throw new Error(`Failed to get user information: ${response.status} ${errorBody}`)
  }

  const data = await response.json()
  return data.data[0]
}

export async function refreshTwitchToken(
  refreshToken: string
): Promise<TwitchTokens> {
  const clientId = getEnvVar('NEXT_PUBLIC_TWITCH_CLIENT_ID', true)!
  const clientSecret = getEnvVar('TWITCH_CLIENT_SECRET', true)!

  const response = await postRefreshToken(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }))

  if (!response.ok) {
    // 本文は接続を解放するため読むが、Error・ログ・永続化contextには保持しない。
    await response.text()
    // 400/401 は失効した refresh token 等の恒久エラーなので postRefreshToken は再送しない。
    // 応答本文は監視経路へ流さない。プロバイダが入力値を反射しても機密情報を残さないため。
    // 呼び出し側がユーザー/BOT の識別子を付けて失敗を永続化するため、ここは
    // console-only warning にする。低レベル層でも error にすると同じ障害が二重起票される。
    logger.warn('Token refresh failed:', { status: response.status })
    throw new TwitchTokenRefreshError(response.status)
  }

  return parseTwitchTokens(
    response,
    // 2xxでも本文が壊れている場合は資格情報そのものの恒久失効とは断定できない。
    // BOTを無効化せず、次の通常リクエストで回復を試せる一時失敗として分類する。
    () => new TwitchTokenRefreshError(response.status, true, 'invalid_response'),
  )
}
