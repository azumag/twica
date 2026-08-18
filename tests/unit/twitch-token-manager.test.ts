/**
 * Twitch token manager の業務・障害境界テスト。
 *
 * #803 で永続化は PlanetScale/Drizzle に一本化された。ここではSQL形状の重複検証より、
 * リトライ、期限判定、Twitch validate応答、refresh後のscope同期という外部挙動を
 * 固定する。DB fixtureは getDb() 境界だけを置き換え、退役したPostgREST APIの形状を
 * テスト内へ持ち込まない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTwitchAccessToken,
  isPermanentRefreshFailure,
  TwitchTokenError,
  twitchTokenErrorReportContext,
  validateTokenScopes,
} from '@/lib/twitch/token-manager'
import { getDb } from '@/lib/db/client'
import { refreshTwitchToken, TwitchTokenRefreshError } from '@/lib/twitch/auth'
import { logger } from '@/lib/logger'

// refreshTwitchTokenだけをvi.fn()へ置き換え、TwitchTokenRefreshError等の他の
// exportは実装のまま残す(Issue #653/#670系テスト用)。token-manager.tsの
// `error instanceof TwitchTokenRefreshError` はこのモジュール経由で同じ
// クラス参照を見るため、自動モックでconstructorのstatus/kind/retryable代入が
// 保持されるかに依存せず、確実に本来のフィールド値で判定できる。
vi.mock('@/lib/twitch/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/twitch/auth')>()
  return { ...actual, refreshTwitchToken: vi.fn() }
})
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

interface DbResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

function createDrizzleDbMock(config: {
  selects?: DbResponse[]
  updates?: DbResponse[]
  refreshState?: Record<string, unknown>
  refreshUpdateError?: unknown
} = {}) {
  let selectIndex = 0
  let updateIndex = 0
  const updateValues: Array<Record<string, unknown>> = []
  const refreshState: Record<string, unknown> = {
    twitch_access_token: 'access-token',
    twitch_refresh_token: 'refresh-token',
    twitch_token_expires_at: pastIso(),
    ...(config.refreshState ?? {}),
  }
  const initialRefreshToken = refreshState.twitch_refresh_token
  // 実装のlease取得は UPDATE ... RETURNING の0/1行で競合を表す。fixtureも
  // request間共有状態を持ち、OAuthを実行するleaderを一人だけに固定する。
  let refreshLeaseId = refreshState.twitch_refresh_lease_id as string | null | undefined
  const sql = {}

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = selectIndex < responses.length
        ? responses[selectIndex]
        : { rows: [refreshState] }
      selectIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    update: vi.fn(() => {
      const responses = config.updates ?? [{ rows: [{}] }]
      const response = responses[Math.min(updateIndex, responses.length - 1)]
      updateIndex += 1
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(response.rows ?? [])
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          updateValues.push(values)
          return builder
        }),
        where: vi.fn(() => builder),
        // refresh のCASは returning() の行数で勝者を判定する。更新後は旧refresh
        // tokenが変わるため、後続requestは0行となりwinnerを再読込する。
        returning: vi.fn(() => {
          if (config.refreshUpdateError) return Promise.reject(config.refreshUpdateError)
          const values = updateValues.at(-1) ?? {}
          const requestedLeaseId = values.twitch_refresh_lease_id
          if (typeof requestedLeaseId === 'string' && values.twitch_access_token === undefined) {
            if (refreshLeaseId && refreshLeaseId !== requestedLeaseId) return Promise.resolve([])
            refreshLeaseId = requestedLeaseId
            Object.assign(refreshState, values)
            return Promise.resolve([{ leaseId: requestedLeaseId }])
          }
          if (values.twitch_refresh_lease_expires_at !== undefined
            && values.twitch_access_token === undefined) {
            return Promise.resolve(refreshLeaseId ? [{ leaseId: refreshLeaseId }] : [])
          }
          if (refreshState.twitch_refresh_token !== initialRefreshToken || !refreshLeaseId) return Promise.resolve([])
          Object.assign(refreshState, values)
          refreshLeaseId = null
          return Promise.resolve([{ twitch_access_token: refreshState.twitch_access_token }])
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }

  return { db, sql, updateValues, refreshState }
}

function primeDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: mock.sql } as any)
}

const futureIso = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const pastIso = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

function tokenRow(options: {
  token?: string | null
  refreshToken?: string | null
  expiresAt?: string | null
} = {}) {
  return {
    twitch_access_token: options.token === undefined ? 'access-token' : options.token,
    twitch_refresh_token:
      options.refreshToken === undefined ? 'refresh-token' : options.refreshToken,
    twitch_token_expires_at:
      options.expiresAt === undefined ? futureIso() : options.expiresAt,
  }
}

describe('Twitch Token Manager: PlanetScale/Drizzle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('getTwitchAccessToken', () => {
    it('一時的な接続断から再取得して有効なトークンを返す', async () => {
      vi.useFakeTimers()
      const fixture = createDrizzleDbMock({
        selects: [
          { error: { code: 'CONNECTION_CLOSED', message: 'connection closed' } },
          { rows: [tokenRow()] },
        ],
      })
      primeDb(fixture)

      const tokenPromise = getTwitchAccessToken('user-1')
      await vi.runAllTimersAsync()

      await expect(tokenPromise).resolves.toBe('access-token')
      // withDbRetry の規約どおり、再試行ごとに getDb() 自体も取り直す。
      expect(getDb).toHaveBeenCalledTimes(2)
    })

    it.each([
      [[], null],
      [[tokenRow({ token: null })], null],
      [[tokenRow({ refreshToken: null })], null],
      [[tokenRow({ expiresAt: null })], null],
      [[tokenRow({ expiresAt: 'not-a-date' })], null],
    ])('不完全なDB行を認証トークンとして返さない', async (rows, expected) => {
      const fixture = createDrizzleDbMock({ selects: [{ rows }] })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).resolves.toBe(expected)
      expect(refreshTwitchToken).not.toHaveBeenCalled()
    })

    it('refresh後はtokenとTwitch応答scopeを同じCAS UPDATEで全置換する', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['scope:new'],
      })
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [tokenRow({ expiresAt: pastIso() })] }],
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).resolves.toBe('new-token')
      expect(fixture.refreshState).toMatchObject({
        twitch_access_token: 'new-token',
        twitch_refresh_token: 'new-refresh-token',
        twitch_scopes: ['scope:new'],
      })
    })

    it('CAS保存に失敗したらトークンを返さずrefresh失敗にする', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['scope:new'],
      })
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [tokenRow({ expiresAt: pastIso() })] }],
        refreshUpdateError: { code: '23505', message: 'CAS save failed' },
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({
        code: 'REFRESH_FAILED',
      })
      expect(fixture.refreshState.twitch_access_token).toBe('access-token')
    })

    // Issue #653/#670/#654/#655: これらのauto-generated bug reportは、refresh
    // 失敗のContextが空で、恒久エラー(無効なrefresh token等)か一時エラー
    // (429/5xx/network)かを区別できず、着手可能な修正案を出せないと判定
    // されていた。この2件はその「着手可能条件」(診断情報の記録)を固定する。
    it('Twitch APIが401を返してrefresh失敗した場合、status/kind/retryableをログとTwitchTokenErrorの両方へ記録する(originalErrorへは生のDBエラー混入を避けるため保持しない)', async () => {
      const refreshError = new TwitchTokenRefreshError(401)
      vi.mocked(refreshTwitchToken).mockRejectedValue(refreshError)
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [tokenRow({ expiresAt: pastIso() })] },
          // refreshAndPersist失敗後、runWithRefreshLeaseはreadUserRefreshWinner()で
          // 「並行request/callbackが既に新トークンを保存済みでないか」を再確認する
          // (token-manager.ts:145)。空行を返し、winnerなし=注入したエラーがそのまま
          // 伝播することを検証する(fixtureの既定フォールバックは常に既存の
          // 'access-token'を返してしまい、winnerありと誤認してエラーを隠蔽するため)。
          { rows: [] },
        ],
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({
        code: 'REFRESH_FAILED',
        // originalErrorはこのcatchがDBエラー(lease/CAS更新、bind paramsに
        // token実値を含み得る)も受け取るため意図的に付与しない
        // (token-manager.tsのtwitchTokenRefreshFailureContext doc参照)。
        originalError: undefined,
        refreshStatus: 401,
        refreshErrorKind: 'http',
        refreshRetryable: false,
      })
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to refresh Twitch access token',
        expect.objectContaining({
          twitchUserId: 'user-1',
          refreshStatus: 401,
          refreshErrorKind: 'http',
          refreshRetryable: false,
        }),
      )
    })

    it('Twitch APIがネットワークエラー(status無し)でrefresh失敗した場合、一時エラーとして記録する', async () => {
      const refreshError = new TwitchTokenRefreshError(undefined)
      vi.mocked(refreshTwitchToken).mockRejectedValue(refreshError)
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [tokenRow({ expiresAt: pastIso() })] },
          { rows: [] }, // readUserRefreshWinner: winnerなし(上のテストの注記参照)
        ],
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({
        code: 'REFRESH_FAILED',
      })
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to refresh Twitch access token',
        expect.objectContaining({
          refreshStatus: undefined,
          refreshErrorKind: 'network',
          refreshRetryable: true,
        }),
      )
    })

    it('DB保存エラー(TwitchTokenRefreshErrorではない)でrefresh失敗した場合、診断フィールドを付与しない', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: ['scope:new'],
      })
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [tokenRow({ expiresAt: pastIso() })] }],
        refreshUpdateError: { code: '23505', message: 'CAS save failed' },
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({
        code: 'REFRESH_FAILED',
      })
      const [, loggedContext] = vi.mocked(logger.warn).mock.calls.at(-1) ?? []
      expect(loggedContext).not.toHaveProperty('refreshStatus')
      expect(loggedContext).not.toHaveProperty('refreshErrorKind')
    })

    it('空scopeも同じCAS UPDATEへ保存する', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue({
        access_token: 'new-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        scope: [],
      })
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [tokenRow({ expiresAt: pastIso() })] }],
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).resolves.toBe('new-token')
      expect(fixture.refreshState.twitch_scopes).toEqual([])
    })
  })

  describe('validateTokenScopes', () => {
    function primeValidationRow(row: Record<string, unknown> | null) {
      const fixture = createDrizzleDbMock({
        selects: [{ rows: row ? [row] : [] }],
      })
      primeDb(fixture)
    }

    it('期限内トークンの実scopeをTwitch validateから返す', async () => {
      primeValidationRow({
        twitch_access_token: 'access-token',
        twitch_token_expires_at: futureIso(),
      })
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ scopes: ['scope:a', 'scope:b'] }),
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(validateTokenScopes('user-1')).resolves.toEqual([
        'scope:a',
        'scope:b',
      ])
      expect(fetchMock).toHaveBeenCalledWith(
        'https://id.twitch.tv/oauth2/validate',
        { headers: { Authorization: 'OAuth access-token' } }
      )
    })

    it('期限切れトークンはTwitch APIを呼ばず判定不能(null)にする', async () => {
      primeValidationRow({
        twitch_access_token: 'access-token',
        twitch_token_expires_at: pastIso(),
      })
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      await expect(validateTokenScopes('user-1')).resolves.toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([401, 403])('Twitch %i は無効トークンとして空scopeを返す', async (status) => {
      primeValidationRow({
        twitch_access_token: 'access-token',
        twitch_token_expires_at: futureIso(),
      })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }))

      await expect(validateTokenScopes('user-1')).resolves.toEqual([])
    })

    it('期限列がnullならTwitchを正本として検証を続行する', async () => {
      primeValidationRow({
        twitch_access_token: 'access-token',
        twitch_token_expires_at: null,
      })
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ scopes: ['scope:a'] }),
      }))

      await expect(validateTokenScopes('user-1')).resolves.toEqual(['scope:a'])
    })

    it.each([
      ['API 5xx', { row: tokenRow(), response: { ok: false, status: 500 } }],
      ['アクセストークンなし', {
        row: {
          twitch_access_token: null,
          twitch_token_expires_at: futureIso(),
        },
        response: null,
      }],
      ['ユーザー行なし', { row: null, response: null }],
    ])('%s は判定不能(null)としてDB値を壊さない', async (_name, options) => {
      primeValidationRow(options.row)
      const fetchMock = vi.fn()
      if (options.response) {
        fetchMock.mockResolvedValue(options.response)
      }
      vi.stubGlobal('fetch', fetchMock)

      await expect(validateTokenScopes('user-1')).resolves.toBeNull()
    })

    it('DB例外は呼び出し側へ伝播させず null を返す', async () => {
      const fixture = createDrizzleDbMock({
        selects: [{ error: new Error('database unavailable') }],
      })
      primeDb(fixture)

      await expect(validateTokenScopes('user-1')).resolves.toBeNull()
    })
  })

  // Issue #653/#670: API境界(handleApiError)がPlanetScale errorsテーブルの
  // contextへ載せるための診断summaryを抽出する純粋関数。getTwitchAccessToken
  // 経由の統合テストとは別に、境界条件を直接固定する。
  describe('twitchTokenErrorReportContext', () => {
    it('REFRESH_FAILED かつ refreshStatus/refreshErrorKind を持つ TwitchTokenError から診断summaryを返す', () => {
      const error = new TwitchTokenError(
        'Failed to refresh Twitch access token',
        'REFRESH_FAILED',
        undefined,
        401,
        'http',
        false,
      )
      expect(twitchTokenErrorReportContext(error)).toEqual({
        refreshStatus: 401,
        refreshErrorKind: 'http',
        refreshRetryable: false,
      })
    })

    it('REFRESH_FAILED でも診断フィールドが無ければ undefined を返す(DBエラー由来のケース)', () => {
      const error = new TwitchTokenError('Failed to refresh Twitch access token', 'REFRESH_FAILED')
      expect(twitchTokenErrorReportContext(error)).toBeUndefined()
    })

    it('REFRESH_FAILED以外のcode(DATABASE_ERROR等)ではundefinedを返す', () => {
      const error = new TwitchTokenError(
        'Failed to fetch user tokens from database',
        'DATABASE_ERROR',
        undefined,
        401,
        'http',
        false,
      )
      expect(twitchTokenErrorReportContext(error)).toBeUndefined()
    })

    it('TwitchTokenErrorではないerrorに対してはundefinedを返す', () => {
      expect(twitchTokenErrorReportContext(new Error('plain error'))).toBeUndefined()
      expect(twitchTokenErrorReportContext('string error')).toBeUndefined()
      expect(twitchTokenErrorReportContext(null)).toBeUndefined()
    })
  })

  describe('isPermanentRefreshFailure', () => {
    // Issue #1018: refreshErrorKind/refreshStatus/refreshRetryableをauth.tsの
    // 生み出し方(network=undefined/true、http=status/集合有無、
    // invalid_response=2xx/true)そのままの形でTwitchTokenErrorへ載せたものを作る。
    function makeRefreshError(
      status?: number,
      kind?: 'network' | 'http' | 'invalid_response',
      retryable?: boolean,
    ) {
      return new TwitchTokenError(
        'Failed to refresh Twitch access token',
        'REFRESH_FAILED',
        undefined,
        status,
        kind,
        retryable,
      )
    }

    it('kind=httpかつstatusが400/401(恒久失効)の場合はtrueを返す', () => {
      expect(isPermanentRefreshFailure(makeRefreshError(400, 'http', false))).toBe(true)
      expect(isPermanentRefreshFailure(makeRefreshError(401, 'http', false))).toBe(true)
    })

    it('一過性失敗(429/5xx)はrefreshRetryable=falseでもfalseを返す', () => {
      // 429/500/502/503/504/522/523/524はauth.tsでretryable=true
      expect(isPermanentRefreshFailure(makeRefreshError(429, 'http', true))).toBe(false)
      expect(isPermanentRefreshFailure(makeRefreshError(502, 'http', true))).toBe(false)
      // 520/521/525/526/530(Cloudflare系)・501/505はREFRESH_RETRYABLE_STATUSESに
      // 含まれずrefreshRetryable === falseになるが一時障害。旧来の補集合判定で
      // 恒久失効と誤判定してcapabilityをreauth_requiredへ誤確定させるリグレッション
      // ガードとして固定する。
      for (const status of [501, 505, 520, 521, 525, 526, 530]) {
        expect(isPermanentRefreshFailure(makeRefreshError(status, 'http', false))).toBe(false)
      }
      // 403もWAF・client設定・上流機能起因の一過性障害になり得るため恒久失効と
      // 断定できない(shouldDisableBotCredential と同一方針)。
      expect(isPermanentRefreshFailure(makeRefreshError(403, 'http', false))).toBe(false)
    })

    it('networkエラー(kind=network、status未定義)はfalseを返す', () => {
      expect(isPermanentRefreshFailure(makeRefreshError(undefined, 'network', true))).toBe(false)
    })

    it('invalid_response(2xx、retryable=true)はfalseを返す', () => {
      expect(isPermanentRefreshFailure(makeRefreshError(200, 'invalid_response', true))).toBe(false)
    })

    it('DB障害起因でdiagnostic未付与(全フィールドundefined)はfalseを返す', () => {
      const error = new TwitchTokenError('Failed to refresh Twitch access token', 'REFRESH_FAILED')
      expect(isPermanentRefreshFailure(error)).toBe(false)
    })

    it('REFRESH_FAILED以外のcode・TwitchTokenError以外ではfalseを返す', () => {
      expect(isPermanentRefreshFailure(new TwitchTokenError('No Twitch token found', 'NO_TOKEN'))).toBe(false)
      expect(
        isPermanentRefreshFailure(
          new TwitchTokenError('db down', 'DATABASE_ERROR', undefined, 401, 'http', false),
        ),
      ).toBe(false)
      expect(isPermanentRefreshFailure(new Error('plain error'))).toBe(false)
      expect(isPermanentRefreshFailure(null)).toBe(false)
    })
  })
})
