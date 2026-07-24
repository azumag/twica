/**
 * #803: hasTwitchSub の PlanetScale/Drizzle 専用クエリ契約テスト。
 *
 * 読み取りとキャッシュ更新が同居するため、単一のDrizzle fixtureで SELECT→Twitch API
 * →UPDATEの流れを検証する。退役したDB_DRIVER分岐のパリティではなく、現行経路が
 * schema object、returning、障害時の前回値保持を正しく使うことを固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { hasTwitchSub } from '@/lib/twitch/sub-check'
import { getTwitchAccessToken } from '@/lib/twitch/token-manager'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger'
import { users as usersTable } from '@/lib/db/schema'

vi.mock('@/lib/twitch/token-manager', () => ({
  getTwitchAccessToken: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

interface DbResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

interface UpdateCall {
  table: unknown
  set?: Record<string, unknown>
  where?: unknown
  returning?: Record<string, unknown>
}

function createDrizzleDbMock(config: {
  select?: DbResponse
  updates?: DbResponse[]
}) {
  const updateCalls: UpdateCall[] = []
  let updateIndex = 0
  const selectResponse = config.select ?? { rows: [] }

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const resolve = () =>
        selectResponse.error
          ? Promise.reject(selectResponse.error)
          : Promise.resolve(
              (selectResponse.rows ?? []).map((row) =>
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
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [{ twitch_user_id: 'user-1' }] }]
      const response = responses[Math.min(updateIndex, responses.length - 1)]
      updateIndex += 1
      const call: UpdateCall = { table }
      updateCalls.push(call)
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(response.rows ?? [])
      const builder: any = {
        set: vi.fn((values: Record<string, unknown>) => {
          call.set = values
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        returning: vi.fn((selection: Record<string, unknown>) => {
          call.returning = selection
          return resolve()
        }),
      }
      return builder
    }),
  }

  return { db, updateCalls }
}

function primeDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

const subscriptionScope = ['user:read:subscriptions']

function freshUserRow(hasSub: boolean) {
  return {
    twitch_sub_verified_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    twitch_has_sub: hasSub,
    twitch_scopes: subscriptionScope,
  }
}

function staleUserRow(hasSub: boolean) {
  return {
    twitch_sub_verified_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    twitch_has_sub: hasSub,
    twitch_scopes: subscriptionScope,
  }
}

describe('hasTwitchSub: PlanetScale/Drizzle 契約 (#803)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('TWITCH_BROADCASTER_ID', 'broadcaster-123')
    vi.stubEnv('NEXT_PUBLIC_TWITCH_CLIENT_ID', 'client-123')
    vi.mocked(getTwitchAccessToken).mockResolvedValue('access-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it.each([true, false])('有効キャッシュ(%s)を返し、API/UPDATEを省略する', async (hasSub) => {
    const fixture = createDrizzleDbMock({
      select: { rows: [freshUserRow(hasSub)] },
    })
    primeDb(fixture)

    await expect(hasTwitchSub('user-1')).resolves.toBe(hasSub)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(fixture.updateCalls).toHaveLength(0)
  })

  it('期限切れ + API 200 は結果と検証時刻を users に保存する', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    const fixture = createDrizzleDbMock({
      select: { rows: [staleUserRow(false)] },
    })
    primeDb(fixture)

    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
    expect(fixture.updateCalls).toHaveLength(1)
    expect(fixture.updateCalls[0]).toMatchObject({
      table: usersTable,
      set: {
        twitch_sub_verified_at: expect.any(String),
        twitch_has_sub: true,
      },
      returning: { twitch_user_id: usersTable.twitch_user_id },
    })
    expect(fixture.updateCalls[0].where).toEqual(
      eq(usersTable.twitch_user_id, 'user-1')
    )
  })

  it('期限切れ + API 404 は非サブスク(false)を正常結果として保存する', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    const fixture = createDrizzleDbMock({
      select: { rows: [staleUserRow(true)] },
    })
    primeDb(fixture)

    await expect(hasTwitchSub('user-1')).resolves.toBe(false)
    expect(fixture.updateCalls[0].set).toEqual({
      twitch_sub_verified_at: expect.any(String),
      twitch_has_sub: false,
    })
  })

  it('API障害は短縮TTL用時刻だけを更新し、前回のtrueを保持する', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    const fixture = createDrizzleDbMock({
      select: { rows: [staleUserRow(true)] },
    })
    primeDb(fixture)

    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
    expect(fixture.updateCalls[0].set).toEqual({
      twitch_sub_verified_at: expect.any(String),
    })
    expect(fixture.updateCalls[0].set).not.toHaveProperty('twitch_has_sub')
  })

  it('正常結果のキャッシュ更新が0行またはDBエラーでもAPI結果を返す', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 })

    const zeroRows = createDrizzleDbMock({
      select: { rows: [staleUserRow(false)] },
      updates: [{ rows: [] }],
    })
    primeDb(zeroRows)
    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
    expect(logger.error).toHaveBeenCalledWith(
      '[TwitchSub] Failed to update sub cache:',
      expect.objectContaining({ twitchUserId: 'user-1', updatedUser: null })
    )

    vi.clearAllMocks()
    vi.mocked(getTwitchAccessToken).mockResolvedValue('access-token')
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    const brokenUpdate = createDrizzleDbMock({
      select: { rows: [staleUserRow(false)] },
      updates: [{ error: { code: '23505', message: 'update failed' } }],
    })
    primeDb(brokenUpdate)
    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
    expect(logger.error).toHaveBeenCalledWith(
      '[TwitchSub] Failed to update sub cache:',
      expect.objectContaining({ twitchUserId: 'user-1' })
    )
  })

  it('API障害後の時刻更新失敗でも前回値を維持する', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    const fixture = createDrizzleDbMock({
      select: { rows: [staleUserRow(true)] },
      updates: [{ rows: [] }],
    })
    primeDb(fixture)

    await expect(hasTwitchSub('user-1')).resolves.toBe(true)
    expect(logger.error).toHaveBeenCalledWith(
      '[TwitchSub] Failed to update error cache timestamp:',
      expect.objectContaining({ twitchUserId: 'user-1', updatedTs: null })
    )
  })

  it.each([
    ['ユーザーなし', []],
    ['scopeなし', [{ ...freshUserRow(true), twitch_scopes: [] }]],
    ['scope列null', [{ ...freshUserRow(true), twitch_scopes: null }]],
  ])('%s は false を返す', async (_name, rows) => {
    const fixture = createDrizzleDbMock({ select: { rows } })
    primeDb(fixture)

    await expect(hasTwitchSub('user-1')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('DB読み取りエラーは false へ安全側に倒す', async () => {
    const fixture = createDrizzleDbMock({
      select: { error: new Error('database unavailable') },
    })
    primeDb(fixture)

    await expect(hasTwitchSub('user-1')).resolves.toBe(false)
  })
})
