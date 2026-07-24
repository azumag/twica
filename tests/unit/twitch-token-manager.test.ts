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
  validateTokenScopes,
} from '@/lib/twitch/token-manager'
import { getDb } from '@/lib/db/client'
import { refreshTwitchToken } from '@/lib/twitch/auth'

vi.mock('@/lib/twitch/auth')
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
  let refreshLockHeld = false
  const makeTx = () => {
    const tx: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim()
      if (query.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }]
      if (query.includes('select twitch_access_token') && query.includes('from users')) {
        return [{
          twitch_access_token: refreshState.twitch_access_token,
          twitch_refresh_token: refreshState.twitch_refresh_token,
          twitch_token_expires_at: refreshState.twitch_token_expires_at,
        }]
      }
      if (query.startsWith('update users')) {
        if (config.refreshUpdateError) throw config.refreshUpdateError
        refreshState.twitch_access_token = values[0]
        refreshState.twitch_refresh_token = values[1]
        refreshState.twitch_token_expires_at = values[2]
        refreshState.twitch_scopes = values[3]
        return [{ twitch_access_token: refreshState.twitch_access_token }]
      }
      throw new Error(`Unexpected refresh SQL: ${query}`)
    }
    tx.array = (value: unknown) => value
    return tx
  }
  const sql = {
    begin: vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
      if (refreshLockHeld) return { acquired: false }
      refreshLockHeld = true
      try { return await callback(makeTx()) } finally { refreshLockHeld = false }
    }),
  }

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
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
        // refresh のCASは更新件数を returning() で判定する。thenableだけでは
        // 成功行が空扱いとなるため、本番Drizzleと同じ結果を返す。
        returning: vi.fn(() => resolve()),
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
})
