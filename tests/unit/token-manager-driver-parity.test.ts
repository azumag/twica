/**
 * #803: token-manager の PlanetScale/Drizzle 専用クエリ契約テスト。
 *
 * 旧ドライバとの結果比較ではなく、現行の単一経路について schema object、SET、WHERE、
 * fallback を直接検証する。fixture は Drizzle builder の公開チェーンだけを実装し、
 * select(fields) の射影も再現するため、列の選択漏れを fixture 側で隠さない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import {
  deleteTwitchTokens,
  getBotAccountForChat,
  getCustomBotAccountDisplayForStreamer,
  getScopeStatus,
  getTwitchAccessToken,
  hasScope,
  removeScope,
  resolveBotAccountForChat,
  saveTwitchScopes,
  saveTwitchTokens,
  TwitchTokenError,
} from '@/lib/twitch/token-manager'
// Error subclass の実装を残し、HTTP 400/401 だけをBOT無効化する判定も実際に通す。
vi.mock('@/lib/twitch/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/twitch/auth')>()
  return { ...actual, refreshTwitchToken: vi.fn() }
})
import { refreshTwitchToken, TwitchTokenRefreshError } from '@/lib/twitch/auth'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger.server'
import {
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  streamers as streamersTable,
  twitchBotAccounts as twitchBotAccountsTable,
  users as usersTable,
} from '@/lib/db/schema'

vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

interface DbResponse {
  rows?: Array<Record<string, unknown>>
  error?: unknown
}

interface SelectCall {
  fields: Record<string, unknown>
  table?: unknown
  where?: unknown
  orderBy?: unknown
  limit?: unknown
}

interface UpdateCall {
  table: unknown
  set?: Record<string, unknown>
  where?: unknown
  returning?: Record<string, unknown>
}

function createDrizzleDbMock(config: {
  selects?: DbResponse[]
  updates?: DbResponse[]
  /** Drizzle CAS が更新する資格情報の現在値。 */
  refreshState?: Record<string, unknown>
  /** OAuth応答中にleaseを失ったleaderのrenew UPDATEを0行にする。 */
  renewLeaseAllowed?: boolean
} = {}) {
  let selectIndex = 0
  let updateIndex = 0
  const selectCalls: SelectCall[] = []
  const updateCalls: UpdateCall[] = []
  const refreshState: Record<string, unknown> = {
    ...userTokenRow(pastIso()),
    ...((config.selects ?? []).flatMap(response => response.rows ?? []).find(row => 'owner_type' in row) ?? {}),
    ...(config.refreshState ?? {}),
  }
  // CASは「最初に旧refresh tokenを読んだ1件」だけを成功させる。SQL ASTのprivate
  // internalsには依存せず、fixtureが保持する現在値で同じ競合結果を再現する。
  const initialRefreshToken = refreshState.twitch_refresh_token
  // lease UPDATE は実DBの returning({ leaseId }) の行数で勝者を決める。fixtureも
  // 最初の所有者だけを通し、保存・解放はその所有者にだけ許可する。
  let refreshLeaseId = refreshState.twitch_refresh_lease_id as string | null | undefined
  const sql = {}

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const isWinnerRead = Object.keys(fields).length === 1
        && 'twitch_access_token' in fields
      const response = selectIndex < responses.length
        ? responses[selectIndex]
        : {
            // winner queryはDB時刻より未来のexpiryをWHEREで要求する。fixtureでも
            // 期限切れの古いaccess tokenをwinnerとして返さない。
            rows: isWinnerRead && new Date(String(refreshState.twitch_token_expires_at)).getTime() <= Date.now()
              ? []
              : [refreshState],
          }
      selectIndex += 1
      const call: SelectCall = { fields }
      selectCalls.push(call)
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (isWinnerRead
                ? (response.rows ?? []).filter(row => new Date(String(row.twitch_token_expires_at)).getTime() > Date.now())
                : (response.rows ?? [])
              ).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn((table: unknown) => {
          call.table = table
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        orderBy: vi.fn((condition: unknown) => {
          call.orderBy = condition
          return builder
        }),
        limit: vi.fn((value: unknown) => {
          call.limit = value
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [{}] }]
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
          // migration前の42703等も、leaseのUPDATEで発生した場合に隠さない。
          if (response.error) return Promise.reject(response.error)
          const requestedLeaseId = call.set?.twitch_refresh_lease_id
          if (typeof requestedLeaseId === 'string' && call.set?.twitch_access_token === undefined) {
            if (refreshLeaseId && refreshLeaseId !== requestedLeaseId) return Promise.resolve([])
            refreshLeaseId = requestedLeaseId
            Object.assign(refreshState, call.set)
            return Promise.resolve([{ leaseId: requestedLeaseId }])
          }
          if (call.set?.twitch_refresh_lease_expires_at !== undefined
            && call.set?.twitch_access_token === undefined) {
            return Promise.resolve(config.renewLeaseAllowed === false || !refreshLeaseId
              ? []
              : [{ leaseId: refreshLeaseId }])
          }
          if (call.set?.twitch_access_token !== undefined) {
            if (refreshState.twitch_refresh_token !== initialRefreshToken || !refreshLeaseId) return Promise.resolve([])
            Object.assign(refreshState, call.set)
            refreshLeaseId = null
            return Promise.resolve([{ twitch_access_token: refreshState.twitch_access_token }])
          }
          return resolve()
        }),
        then: (onFulfilled: any, onRejected: any) => {
          // OAuth失敗時のowner-fenced releaseはRETURNINGを使わない。fixtureでも
          // leaderが残したleaseを解除し、次requestが即時に取得できる状態へ戻す。
          if (call.set?.twitch_refresh_lease_id === null
            && call.set?.twitch_refresh_lease_expires_at === null
            && call.set?.twitch_access_token === undefined) {
            refreshLeaseId = null
            Object.assign(refreshState, call.set)
          }
          if (call.set?.status === 'error') Object.assign(refreshState, call.set)
          return resolve().then(onFulfilled, onRejected)
        },
      }
      return builder
    }),
  }

  return {
    db,
    sql,
    selectCalls,
    updateCalls,
    refreshState,
    // DB時刻でleaseが切れた後は別leaderが取得できる。実際の40秒待機をunit testへ
    // 持ち込まず、期限切れ後のUPDATE条件だけを再現する。
    expireRefreshLease: () => { refreshLeaseId = null },
  }
}

function primeDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: mock.sql } as any)
}

const futureIso = () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
const pastIso = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

const refreshedTokens = {
  access_token: 'new-token',
  refresh_token: 'new-refresh-token',
  expires_in: 3600,
  token_type: 'bearer',
  scope: ['user:read:email'],
}

function userTokenRow(expiresAt = futureIso()) {
  return {
    twitch_access_token: 'valid-token',
    twitch_refresh_token: 'refresh-token',
    twitch_token_expires_at: expiresAt,
  }
}

function botAccountRow(expiresAt = futureIso()) {
  return {
    id: 'bot-account-1',
    owner_type: 'streamer',
    twitch_user_id: 'bot-user-1',
    twitch_username: 'bot_login',
    twitch_display_name: 'Bot Display',
    twitch_access_token: 'bot-token',
    twitch_refresh_token: 'bot-refresh-token',
    twitch_token_expires_at: expiresAt,
  }
}

describe('token-manager: PlanetScale/Drizzle 契約 (#803)', () => {
  beforeEach(() => {
    // clearAllMocks では前ケースの mockResolvedValueOnce が残り、並行BOTケースが
    // 期限内の winner token を読む偽陽性になる。fixture は毎ケースで再設定するので、
    // 実装キューも含めてリセットしてテスト間の資格情報漏れを防ぐ。
    vi.resetAllMocks()
  })

  it('Workers module scopeにrequest間で共有するPromise/Mapを置かない', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/twitch/token-manager.ts'), 'utf8')
    const executableLines = source
      .split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(executableLines).not.toMatch(/^(?:const|let|var)\s+\w+\s*=\s*(?:new\s+Map|Promise\.)/m)
  })

  it('token/BOT下位層の障害ログをlogger.errorへ戻さない', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/twitch/token-manager.ts'), 'utf8')
    const lowerLayerWarnOnlyMessages = [
      'Twitch token columns are missing; denying token access',
      'Database error fetching user tokens',
      'Failed to refresh Twitch access token',
      'Database error fetching BOT account',
      'Chat sender settings schema is missing; disabling BOT chat sender',
      'Database error fetching chat sender settings',
      'Twitch BOT accounts schema is missing; disabling custom BOT sender',
      'Database error fetching custom BOT account',
      'Twitch BOT accounts schema is missing; disabling official BOT sender',
      'Database error fetching official BOT account',
      'Failed to refresh BOT Twitch access token',
    ]

    // logger.server.errorはerrors表と自動Issue作成を起動する。replay pending中の
    // retryable/terminal障害は下位token/BOT層ではwarnに限定し、呼び出し境界の
    // reportErrorへ永続化責任を一元化する。scope判定はgetScopeStatusとhasScopeで
    // 所有境界が異なるため、この文字列契約へ混ぜず、下の実挙動テストで固定する。
    for (const message of lowerLayerWarnOnlyMessages) {
      expect(source).toContain(`logger.warn('${message}'`)
      expect(source).not.toContain(`logger.error('${message}'`)
    }
  })

  describe('getTwitchAccessToken', () => {
    it('期限内トークンを返し、users の3列だけを一意IDで取得する', async () => {
      const fixture = createDrizzleDbMock({ selects: [{ rows: [userTokenRow()] }] })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).resolves.toBe('valid-token')
      expect(fixture.updateCalls).toHaveLength(0)
      expect(fixture.selectCalls[0]).toMatchObject({
        fields: {
          twitch_access_token: usersTable.twitch_access_token,
          twitch_refresh_token: usersTable.twitch_refresh_token,
          twitch_token_expires_at: usersTable.twitch_token_expires_at,
        },
        table: usersTable,
        limit: 1,
      })
      expect(fixture.selectCalls[0].where).toEqual(
        eq(usersTable.twitch_user_id, 'user-1')
      )
    })

    it.each([
      { rows: [] },
      { rows: [{ ...userTokenRow(), twitch_access_token: null }] },
      { rows: [{ ...userTokenRow(), twitch_refresh_token: null }] },
      { rows: [{ ...userTokenRow(), twitch_token_expires_at: null }] },
      { rows: [{ ...userTokenRow(), twitch_token_expires_at: 'invalid-date' }] },
    ])('利用可能なトークンがなければ null を返す', async ({ rows }) => {
      const fixture = createDrizzleDbMock({ selects: [{ rows }] })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).resolves.toBeNull()
    })

    it('期限切れトークンを更新し、トークンと実スコープを同一transactionへ保存する', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue(refreshedTokens)
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [userTokenRow(pastIso())] }],
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).resolves.toBe('new-token')
      expect(refreshTwitchToken).toHaveBeenCalledWith('refresh-token')
      // token と scope は同じ旧 refresh token 条件の一回の CAS で保存する。
      expect(fixture.refreshState).toMatchObject({
        twitch_access_token: 'new-token',
        twitch_refresh_token: 'new-refresh-token',
        twitch_scopes: ['user:read:email'],
      })
      const acquireCall = fixture.updateCalls.find(
        call => typeof call.set?.twitch_refresh_lease_id === 'string',
      )
      const saveCall = fixture.updateCalls.find(
        call => call.set?.twitch_access_token === 'new-token',
      )
      const leaseId = acquireCall?.set?.twitch_refresh_lease_id
      expect(leaseId).toEqual(expect.any(String))
      expect(saveCall?.where).toEqual(and(
        eq(usersTable.twitch_user_id, 'user-1'),
        eq(usersTable.twitch_refresh_token, 'refresh-token'),
        eq(usersTable.twitch_refresh_lease_id, leaseId as string),
      ))
    })

    it('lease列が未デプロイならOAuthを呼ばず、retryableなDATABASE_ERRORへ分類する', async () => {
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [userTokenRow(pastIso())] }],
        updates: [{ error: { code: '42703', message: 'lease column missing' } }],
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({
        name: 'TwitchTokenError',
        code: 'DATABASE_ERROR',
      } satisfies Partial<TwitchTokenError>)
      expect(refreshTwitchToken).not.toHaveBeenCalled()
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Twitch token columns are missing; denying token access',
        expect.objectContaining({ twitchUserId: 'user-1' }),
      )
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })

    it('51並行user refreshはDB leaseでOAuthを一回だけ実行し、全員がwinner tokenを返す', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue({ ...refreshedTokens, access_token: 'winner', refresh_token: 'winner-refresh', scope: ['winner:scope'] })
      const fixture = createDrizzleDbMock({
        selects: Array.from({ length: 51 }, () => ({ rows: [userTokenRow(pastIso())] })),
      })
      primeDb(fixture)

      await expect(Promise.all(Array.from({ length: 51 }, () => getTwitchAccessToken('user-1'))))
        .resolves.toEqual(Array(51).fill('winner'))
      // module scope共有ではなく、DB leaseを取れたleaderだけがOAuthを実行する。
      expect(refreshTwitchToken).toHaveBeenCalledTimes(1)
      expect(fixture.refreshState.twitch_scopes).toEqual(['winner:scope'])
    })

    it('最大13秒かかるuser refreshでもfollowersはleaderの保存結果を返す', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(refreshTwitchToken).mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 13_000))
          return { ...refreshedTokens, access_token: 'slow-winner' }
        })
        const fixture = createDrizzleDbMock({
          selects: [
            { rows: [userTokenRow(pastIso())] },
            { rows: [userTokenRow(pastIso())] },
          ],
        })
        primeDb(fixture)

        const requests = [
          getTwitchAccessToken('user-1'),
          getTwitchAccessToken('user-1'),
        ]
        // acquire UPDATEまで進めてからtimerを流す。開始直後に時刻だけ進めると、
        // async lease取得後に登録される13秒timerが未来に残り、Promise.allがhangする。
        await vi.advanceTimersByTimeAsync(0)
        await vi.runAllTimersAsync()

        await expect(Promise.all(requests)).resolves.toEqual(['slow-winner', 'slow-winner'])
        expect(refreshTwitchToken).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('400/401競合では失敗を確定する前にwinnerの保存結果を再読込する', async () => {
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [userTokenRow(pastIso())] }],
      })
      vi.mocked(refreshTwitchToken).mockImplementation(async () => {
        // OAuth callback/別request がlock取得前にcommitした競合を、endpoint失敗の直後に
        // 表現する。実装は旧refresh tokenだけでcredential削除してはならない。
        Object.assign(fixture.refreshState, {
          twitch_access_token: 'callback-winner',
          twitch_refresh_token: 'callback-refresh',
          twitch_token_expires_at: futureIso(),
        })
        throw new TwitchTokenRefreshError(401)
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).resolves.toBe('callback-winner')
      expect(fixture.refreshState.twitch_refresh_token).toBe('callback-refresh')
    })

    it('leader失敗後はowner-fenced releaseにより次requestが直ちに回復できる', async () => {
      vi.mocked(refreshTwitchToken)
        .mockRejectedValueOnce(new TwitchTokenRefreshError(522))
        .mockResolvedValueOnce(refreshedTokens)
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [userTokenRow(pastIso())] },
          { rows: [userTokenRow(pastIso())] },
        ],
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({ code: 'REFRESH_FAILED' })
      await expect(getTwitchAccessToken('user-1')).resolves.toBe('new-token')
      expect(refreshTwitchToken).toHaveBeenCalledTimes(2)
    })

    it('OAuth応答中にleaseを失った旧leaderはtokenを保存しない', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue(refreshedTokens)
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [userTokenRow(pastIso())] }],
        renewLeaseAllowed: false,
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({ code: 'REFRESH_FAILED' })
      expect(fixture.refreshState.twitch_access_token).toBe('valid-token')
      expect(fixture.updateCalls.some(call => call.set?.twitch_access_token === 'new-token')).toBe(false)
    })

    it('未デプロイ列(42703)を恒久token欠落へ潰さずDATABASE_ERRORにする', async () => {
      const missingColumnError = { code: '42703', message: 'column missing' }
      const missingColumn = createDrizzleDbMock({
        selects: [{ error: missingColumnError }],
      })
      primeDb(missingColumn)
      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({
        name: 'TwitchTokenError',
        code: 'DATABASE_ERROR',
      } satisfies Partial<TwitchTokenError>)
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Twitch token columns are missing; denying token access',
        { twitchUserId: 'user-1', error: missingColumnError },
      )

      // row/token自体が存在しない恒久欠落は引き続きnullであり、schema障害と混同しない。
      const noCredential = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primeDb(noCredential)
      await expect(getTwitchAccessToken('user-1')).resolves.toBeNull()

      const broken = createDrizzleDbMock({
        selects: [{ error: new Error('database unavailable') }],
      })
      primeDb(broken)
      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({
        name: 'TwitchTokenError',
        code: 'DATABASE_ERROR',
      } satisfies Partial<TwitchTokenError>)
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Database error fetching user tokens',
        expect.objectContaining({ twitchUserId: 'user-1' }),
      )
    })
  })

  describe('トークン・スコープ書き込み', () => {
    it('saveTwitchTokens/deleteTwitchTokens はcredentialとleaseを同じUPDATEで置換する', async () => {
      const fixture = createDrizzleDbMock()
      primeDb(fixture)

      await saveTwitchTokens('user-1', refreshedTokens)
      await deleteTwitchTokens('user-1')

      expect(fixture.updateCalls[0]).toMatchObject({
        table: usersTable,
        set: {
          twitch_access_token: 'new-token',
          twitch_refresh_token: 'new-refresh-token',
          twitch_token_expires_at: expect.any(String),
          twitch_refresh_lease_id: null,
          twitch_refresh_lease_expires_at: null,
        },
      })
      expect(fixture.updateCalls[1]).toMatchObject({
        table: usersTable,
        set: {
          twitch_access_token: null,
          twitch_refresh_token: null,
          twitch_token_expires_at: null,
          twitch_refresh_lease_id: null,
          twitch_refresh_lease_expires_at: null,
        },
      })
      for (const call of fixture.updateCalls) {
        expect(call.where).toEqual(eq(usersTable.twitch_user_id, 'user-1'))
      }
    })

    it('saveTwitchTokens は列欠落も成功扱いせず、監視ログを残して伝播する', async () => {
      const missingColumnError = { code: '42703', message: 'column missing' }
      const missingColumn = createDrizzleDbMock({
        updates: [{ error: missingColumnError }],
      })
      primeDb(missingColumn)
      await expect(saveTwitchTokens('user-1', refreshedTokens)).rejects.toBe(missingColumnError)
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Twitch token columns are missing; token save failed closed',
        { twitchUserId: 'user-1', error: missingColumnError },
      )

      const broken = createDrizzleDbMock({
        updates: [{ error: { code: '23505', message: 'constraint violation' } }],
      })
      primeDb(broken)
      await expect(saveTwitchTokens('user-1', refreshedTokens)).rejects.toMatchObject({
        code: '23505',
      })
    })

    it('deleteTwitchTokens は列欠落時にcredential削除を成功扱いせず伝播する', async () => {
      const missingColumnError = { code: '42703', message: 'column missing' }
      const fixture = createDrizzleDbMock({
        updates: [{ error: missingColumnError }],
      })
      primeDb(fixture)

      await expect(deleteTwitchTokens('user-1')).rejects.toBe(missingColumnError)
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Twitch token columns are missing; token deletion failed closed',
        { twitchUserId: 'user-1', error: missingColumnError },
      )
    })

    it.each([
      [['user:write:chat', 'user:read:email'], 'user:write:chat', true],
      [['user:read:email'], 'user:write:chat', false],
      [null, 'user:write:chat', false],
    ])('hasScope はnullable配列を正しく判定する', async (scopes, scope, expected) => {
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [{ twitch_scopes: scopes }] }],
      })
      primeDb(fixture)

      await expect(hasScope('user-1', scope)).resolves.toBe(expected)
    })

    it('hasScope は列欠落時にfalseへ倒し、上位境界がないためerrorを永続化する', async () => {
      const missingColumnError = { code: '42703', message: 'column missing' }
      const fixture = createDrizzleDbMock({
        selects: [{ error: missingColumnError }],
      })
      primeDb(fixture)

      await expect(hasScope('user-1', 'user:write:chat')).resolves.toBe(false)
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'twitch_scopes column is missing; denying scope access',
        {
          twitchUserId: 'user-1',
          scope: 'user:write:chat',
          error: missingColumnError,
        },
      )
    })

    it('hasScope は一般DB障害もfalseへ倒す前にerrorを永続化する', async () => {
      const databaseError = { code: '08006', message: 'connection failure' }
      const fixture = createDrizzleDbMock({
        selects: Array.from({ length: 4 }, () => ({ error: databaseError })),
      })
      primeDb(fixture)

      await expect(hasScope('user-1', 'user:write:chat')).resolves.toBe(false)
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Database error checking scope', {
        twitchUserId: 'user-1',
        scope: 'user:write:chat',
        error: databaseError,
      })
    })

    it.each([
      [['user:write:chat', 'user:read:email'], 'granted'],
      [['user:read:email'], 'missing'],
      [null, 'missing'],
    ] as const)('getScopeStatus は保存スコープを三値契約へ分類する', async (scopes, expected) => {
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [{ twitch_scopes: scopes }] }],
      })
      primeDb(fixture)

      await expect(getScopeStatus('user-1', 'user:write:chat')).resolves.toBe(expected)
    })

    it('getScopeStatus はDB障害をscope不足へ潰さずunavailableにする', async () => {
      const databaseError = { code: '08006', message: 'connection failure' }
      const fixture = createDrizzleDbMock({
        // 08006 は冪等READで「初回 + 3回」試行されるため、全試行を障害にして
        // fixture の応答枯渇時フォールバック（空行）を成功扱いさせない。
        selects: Array.from({ length: 4 }, () => ({ error: databaseError })),
      })
      primeDb(fixture)

      await expect(getScopeStatus('user-1', 'user:write:chat')).resolves.toBe('unavailable')
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('Database error checking scope', {
        twitchUserId: 'user-1',
        scope: 'user:write:chat',
        error: databaseError,
      })
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })

    it('getScopeStatus は列欠落もunavailableへ分類し、上位報告に備えてwarnだけを残す', async () => {
      const missingColumnError = { code: '42703', message: 'column missing' }
      const fixture = createDrizzleDbMock({
        selects: [{ error: missingColumnError }],
      })
      primeDb(fixture)

      await expect(getScopeStatus('user-1', 'user:write:chat')).resolves.toBe('unavailable')
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'twitch_scopes column is missing; denying scope access',
        {
          twitchUserId: 'user-1',
          scope: 'user:write:chat',
          error: missingColumnError,
        },
      )
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })

    it('removeScope は該当値だけを除外し、未保持ならUPDATEしない', async () => {
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ twitch_scopes: ['user:write:chat', 'user:read:email'] }] },
          { rows: [{ twitch_scopes: ['user:read:email'] }] },
        ],
      })
      primeDb(fixture)

      await removeScope('user-1', 'user:write:chat')
      await removeScope('user-1', 'user:write:chat')

      expect(fixture.updateCalls).toHaveLength(1)
      expect(fixture.updateCalls[0]).toMatchObject({
        table: usersTable,
        set: { twitch_scopes: ['user:read:email'] },
      })
      expect(fixture.updateCalls[0].where).toEqual(
        eq(usersTable.twitch_user_id, 'user-1')
      )
    })

    it('removeScope は列欠落時に権限同期を成功扱いせず伝播する', async () => {
      const missingColumnError = { code: '42703', message: 'column missing' }
      const fixture = createDrizzleDbMock({
        selects: [{ error: missingColumnError }],
      })
      primeDb(fixture)

      await expect(removeScope('user-1', 'user:write:chat')).rejects.toBe(missingColumnError)
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'twitch_scopes column is missing; scope removal failed closed',
        {
          twitchUserId: 'user-1',
          scope: 'user:write:chat',
          error: missingColumnError,
        },
      )
    })

    it('saveTwitchScopes は全置換し、列欠落を含むDBエラーを伝播する', async () => {
      const ok = createDrizzleDbMock()
      primeDb(ok)
      await saveTwitchScopes('user-1', ['scope:a', 'scope:b'])
      expect(ok.updateCalls[0]).toMatchObject({
        table: usersTable,
        set: { twitch_scopes: ['scope:a', 'scope:b'] },
      })

      const missingColumnError = { code: '42703', message: 'column missing' }
      const missingColumn = createDrizzleDbMock({
        updates: [{ error: missingColumnError }],
      })
      primeDb(missingColumn)
      await expect(saveTwitchScopes('user-1', ['scope:a'])).rejects.toBe(missingColumnError)
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'twitch_scopes column is missing; scope save failed closed',
        { twitchUserId: 'user-1', error: missingColumnError },
      )

      const broken = createDrizzleDbMock({
        updates: [{ error: { code: '23505', message: 'constraint violation' } }],
      })
      primeDb(broken)
      await expect(saveTwitchScopes('user-1', ['scope:a'])).rejects.toMatchObject({
        code: '23505',
      })
    })
  })

  describe('getBotAccountForChat', () => {
    it('active BOTの一時refresh失敗はretryable-unavailableとして保持する', async () => {
      vi.mocked(refreshTwitchToken).mockRejectedValue(new TwitchTokenRefreshError(522))
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
          { rows: [botAccountRow(pastIso())] },
        ],
        // 一時障害では恒久失効用UPDATEが走らず、既存active状態が維持されることを検証する。
        refreshState: { status: 'active' },
      })
      primeDb(fixture)

      await expect(resolveBotAccountForChat('broadcaster-1')).resolves.toEqual({
        status: 'retryable-unavailable',
        reason: 'configured BOT credential is temporarily unavailable',
      })
      expect(fixture.refreshState.status).toBe('active')
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Failed to refresh BOT Twitch access token',
        {
          broadcasterTwitchUserId: 'broadcaster-1',
          accountId: 'bot-account-1',
          // PR #997レビュー指摘: ログ単体でterminal/retryableを判別できるよう
          // terminalも併記する(shouldDisableBotCredentialの判定結果)。
          terminal: false,
          // Issue #653/#670系: 診断情報(twitchTokenRefreshFailureContext)。
          // 522はREFRESH_RETRYABLE_STATUSESに含まれるためretryable=true。
          refreshStatus: 522,
          refreshErrorKind: 'http',
          refreshRetryable: true,
        },
      )
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })

    it('BOT解決のDB障害はretryable-unavailableとして保持する', async () => {
      const databaseError = { code: '08006', message: 'connection failure' }
      const fixture = createDrizzleDbMock({
        // 冪等READの初回+3回をすべて失敗させ、空行fallbackを混入させない。
        selects: Array.from({ length: 4 }, () => ({ error: databaseError })),
      })
      primeDb(fixture)

      await expect(resolveBotAccountForChat('broadcaster-1')).resolves.toEqual({
        status: 'retryable-unavailable',
        reason: 'unable to resolve BOT sender from database',
      })
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Database error fetching BOT account',
        { broadcasterTwitchUserId: 'broadcaster-1', error: databaseError },
      )
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })

    it('BOT schema欠落は未設定へ潰さずretryable-unavailableとして保持する', async () => {
      const missingTableError = { code: '42P01', message: 'table missing' }
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          { error: missingTableError },
        ],
      })
      primeDb(fixture)

      await expect(resolveBotAccountForChat('broadcaster-1')).resolves.toEqual({
        status: 'retryable-unavailable',
        reason: 'BOT sender schema is unavailable',
      })
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Chat sender settings schema is missing; disabling BOT chat sender',
        { broadcasterTwitchUserId: 'broadcaster-1', error: missingTableError },
      )
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })

    it('BOTの恒久refresh失効はterminal-unavailableとして保持する', async () => {
      vi.mocked(refreshTwitchToken).mockRejectedValue(new TwitchTokenRefreshError(401))
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
          { rows: [botAccountRow(pastIso())] },
        ],
      })
      primeDb(fixture)

      await expect(resolveBotAccountForChat('broadcaster-1')).resolves.toEqual({
        status: 'terminal-unavailable',
        reason: 'configured BOT credential requires reauthorization',
      })
      expect(fixture.refreshState.status).toBe('error')
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Failed to refresh BOT Twitch access token',
        {
          broadcasterTwitchUserId: 'broadcaster-1',
          accountId: 'bot-account-1',
          terminal: true,
          // 401はREFRESH_RETRYABLE_STATUSESに含まれないためretryable=false。
          refreshStatus: 401,
          refreshErrorKind: 'http',
          refreshRetryable: false,
        },
      )
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
    })

    it('sender_modeが custom_bot/official_bot/streamer のいずれでもない未知値はterminal-unavailableとして保持する', async () => {
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          { rows: [{ sender_mode: 'unknown_mode', custom_bot_account_id: null }] },
        ],
      })
      primeDb(fixture)

      await expect(resolveBotAccountForChat('broadcaster-1')).resolves.toEqual({
        status: 'terminal-unavailable',
        reason: 'configured BOT sender mode is unsupported',
      })
      // DB CHECK制約追加前の未知値・手動不整合を本人scope不足へ誤って倒さないよう、
      // BOTアカウントの追加照会（3クエリ目）は発行されない。
      expect(fixture.selectCalls).toHaveLength(2)
    })

    it('custom bot の期限内トークンを返し、3段階の参照先を固定する', async () => {
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          {
            rows: [{
              sender_mode: 'custom_bot',
              custom_bot_account_id: 'bot-account-1',
            }],
          },
          { rows: [botAccountRow()] },
        ],
      })
      primeDb(fixture)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toEqual({
        accountId: 'bot-account-1',
        senderId: 'bot-user-1',
        username: 'bot_login',
        displayName: 'Bot Display',
        accessToken: 'bot-token',
        ownerType: 'streamer',
      })
      expect(fixture.selectCalls.map((call) => call.table)).toEqual([
        streamersTable,
        streamerChatSenderSettingsTable,
        twitchBotAccountsTable,
      ])
      expect(fixture.updateCalls).toHaveLength(0)
    })

    it('期限切れBOTトークンを更新し、返却値には新アクセストークンを使う', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue(refreshedTokens)
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          {
            rows: [{
              sender_mode: 'custom_bot',
              custom_bot_account_id: 'bot-account-1',
            }],
          },
          { rows: [botAccountRow(pastIso())] },
        ],
      })
      primeDb(fixture)

      const result = await getBotAccountForChat('broadcaster-1')

      expect(result?.accessToken).toBe('new-token')
      expect(fixture.refreshState).toMatchObject({
        twitch_access_token: 'new-token',
        twitch_refresh_token: 'new-refresh-token',
        scopes: ['user:read:email'],
      })
      const acquireCall = fixture.updateCalls.find(
        call => typeof call.set?.twitch_refresh_lease_id === 'string',
      )
      const saveCall = fixture.updateCalls.find(
        call => call.set?.twitch_access_token === 'new-token',
      )
      const leaseId = acquireCall?.set?.twitch_refresh_lease_id
      expect(leaseId).toEqual(expect.any(String))
      expect(saveCall?.where).toEqual(and(
        eq(twitchBotAccountsTable.id, 'bot-account-1'),
        eq(twitchBotAccountsTable.twitch_refresh_token, 'bot-refresh-token'),
        eq(twitchBotAccountsTable.twitch_refresh_lease_id, leaseId as string),
      ))
    })

    it('同じBOTの並行refreshはlease winnerのscopeを保持する', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue({ ...refreshedTokens, access_token: 'winner-bot', refresh_token: 'winner-bot-refresh', scope: ['winner:scope'] })
      const expired = botAccountRow(pastIso())
      const fixture = createDrizzleDbMock({
        selects: [
          // 各 await の直後にもう一方のリクエストが進むため、同じテーブルの
          // 2 reads が先に消費される実際の interleave をキューで表す。
          { rows: [{ id: 'streamer-1' }] }, { rows: [{ id: 'streamer-1' }] },
          { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
          { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
          { rows: [expired] }, { rows: [expired] },
        ],
      })
      primeDb(fixture)

      const results = await Promise.all([
        getBotAccountForChat('broadcaster-1'),
        getBotAccountForChat('broadcaster-2'),
      ])

      expect(refreshTwitchToken).toHaveBeenCalledTimes(1)
      expect(results.map(result => result?.accessToken)).toEqual(['winner-bot', 'winner-bot'])
      expect(fixture.refreshState.scopes).toEqual(['winner:scope'])
    })

    it('最大13秒かかるBOT refreshでもfollowerを含めwinnerを返し、OAuthは一回だけ実行する', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(refreshTwitchToken).mockImplementation(async () => {
          await new Promise(resolve => setTimeout(resolve, 13_000))
          return { ...refreshedTokens, access_token: 'slow-bot-winner' }
        })
        const expired = botAccountRow(pastIso())
        const fixture = createDrizzleDbMock({
          selects: [
            { rows: [{ id: 'streamer-1' }] }, { rows: [{ id: 'streamer-1' }] },
            { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
            { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
            { rows: [expired] }, { rows: [expired] },
          ],
        })
        primeDb(fixture)

        const requests = [
          getBotAccountForChat('broadcaster-1'),
          getBotAccountForChat('broadcaster-2'),
        ]
        // user版と同じく、lease acquireのasync continuationが13秒timerを登録して
        // から全timerを進めることで、runner依存の未登録timer hangを防ぐ。
        await vi.advanceTimersByTimeAsync(0)
        await vi.runAllTimersAsync()

        await expect(Promise.all(requests)).resolves.toEqual([
          expect.objectContaining({ accessToken: 'slow-bot-winner' }),
          expect.objectContaining({ accessToken: 'slow-bot-winner' }),
        ])
        expect(refreshTwitchToken).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('BOTの401競合では保存済みwinnerを返し、credentialを無効化しない', async () => {
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          {
            rows: [{
              sender_mode: 'custom_bot',
              custom_bot_account_id: 'bot-account-1',
            }],
          },
          { rows: [botAccountRow(pastIso())] },
        ],
      })
      vi.mocked(refreshTwitchToken).mockImplementation(async () => {
        Object.assign(fixture.refreshState, {
          twitch_access_token: 'callback-winner',
          twitch_refresh_token: 'callback-refresh',
          twitch_token_expires_at: futureIso(),
          status: 'active',
        })
        throw new TwitchTokenRefreshError(401)
      })
      primeDb(fixture)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toMatchObject({
        accessToken: 'callback-winner',
      })
      expect(fixture.refreshState.status).toBe('active')
    })

    it.each([400, 401])('BOTのHTTP %iだけを失効としてstatus=errorに記録する', async (status) => {
      vi.mocked(refreshTwitchToken).mockRejectedValue(new TwitchTokenRefreshError(status))
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          {
            rows: [{
              sender_mode: 'custom_bot',
              custom_bot_account_id: 'bot-account-1',
            }],
          },
          { rows: [botAccountRow(pastIso())] },
        ],
      })
      primeDb(fixture)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
      expect(fixture.refreshState.status).toBe('error')
      const acquireCall = fixture.updateCalls.find(
        call => typeof call.set?.twitch_refresh_lease_id === 'string',
      )
      const errorCall = fixture.updateCalls.find(call => call.set?.status === 'error')
      const leaseId = acquireCall?.set?.twitch_refresh_lease_id
      expect(leaseId).toEqual(expect.any(String))
      expect(errorCall?.where).toEqual(and(
        eq(twitchBotAccountsTable.id, 'bot-account-1'),
        eq(twitchBotAccountsTable.twitch_refresh_token, 'bot-refresh-token'),
        eq(twitchBotAccountsTable.twitch_refresh_lease_id, leaseId as string),
        eq(twitchBotAccountsTable.status, 'active'),
      ))
    })

    it.each([403, 404, 501, 522])('BOTのHTTP %iは失効と断定せずactiveを維持する', async (status) => {
      vi.mocked(refreshTwitchToken).mockRejectedValue(new TwitchTokenRefreshError(status))
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
          { rows: [botAccountRow(pastIso())] },
        ],
      })
      primeDb(fixture)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
      // refresh開始のlease取得は行うが、400/401以外でcredentialを無効化しない。
      expect(fixture.updateCalls.some(call => call.set?.status === 'error')).toBe(false)
    })

    it.each([
      [[{ id: 'streamer-1' }], [{ sender_mode: 'streamer', custom_bot_account_id: null }]],
      [[{ id: 'streamer-1' }], []],
      [[], []],
    ])('BOTを使わない設定または行なしは null を返す', async (streamerRows, settingsRows) => {
      const fixture = createDrizzleDbMock({
        selects: [{ rows: streamerRows }, { rows: settingsRows }],
      })
      primeDb(fixture)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
    })

    it('BOT設定テーブル未デプロイ(42P01)は監視ログを残してnullへ倒す', async () => {
      const missingTableError = { code: '42P01', message: 'table missing' }
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [{ id: 'streamer-1' }] },
          { error: missingTableError },
        ],
      })
      primeDb(fixture)

      await expect(getBotAccountForChat('broadcaster-1')).resolves.toBeNull()
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        'Chat sender settings schema is missing; disabling BOT chat sender',
        { broadcasterTwitchUserId: 'broadcaster-1', error: missingTableError },
      )
    })
  })

  describe('getCustomBotAccountDisplayForStreamer', () => {
    it('activeなcustom botの表示名を返す', async () => {
      const fixture = createDrizzleDbMock({
        selects: [
          {
            rows: [{
              sender_mode: 'custom_bot',
              custom_bot_account_id: 'bot-account-1',
            }],
          },
          {
            rows: [{
              twitch_username: 'bot_login',
              twitch_display_name: 'Bot Display',
            }],
          },
        ],
      })
      primeDb(fixture)

      await expect(
        getCustomBotAccountDisplayForStreamer('streamer-1')
      ).resolves.toEqual({
        username: 'bot_login',
        displayName: 'Bot Display',
      })
      expect(fixture.selectCalls.map((call) => call.table)).toEqual([
        streamerChatSenderSettingsTable,
        twitchBotAccountsTable,
      ])
    })

    it('設定なし・参照エラーは null を返す', async () => {
      const noSettings = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primeDb(noSettings)
      await expect(
        getCustomBotAccountDisplayForStreamer('streamer-1')
      ).resolves.toBeNull()

      const broken = createDrizzleDbMock({
        selects: [{ error: new Error('database unavailable') }],
      })
      primeDb(broken)
      await expect(
        getCustomBotAccountDisplayForStreamer('streamer-1')
      ).resolves.toBeNull()
    })
  })
})
