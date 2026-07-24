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
  getTwitchAccessToken,
  hasScope,
  removeScope,
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
} = {}) {
  let selectIndex = 0
  let updateIndex = 0
  const selectCalls: SelectCall[] = []
  const updateCalls: UpdateCall[] = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const call: SelectCall = { fields }
      selectCalls.push(call)
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
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
          return resolve()
        }),
        then: (onFulfilled: any, onRejected: any) =>
          resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }

  return { db, selectCalls, updateCalls }
}

function primeDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
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

    it('期限切れトークンを更新し、トークンと実スコープを users へ保存する', async () => {
      vi.mocked(refreshTwitchToken).mockResolvedValue(refreshedTokens)
      const fixture = createDrizzleDbMock({
        selects: [{ rows: [userTokenRow(pastIso())] }],
      })
      primeDb(fixture)

      await expect(getTwitchAccessToken('user-1')).resolves.toBe('new-token')
      expect(refreshTwitchToken).toHaveBeenCalledWith('refresh-token')
      // token と scope は同じ旧 refresh token 条件の一回の CAS で保存する。
      expect(fixture.updateCalls).toHaveLength(1)
      expect(fixture.updateCalls[0]).toMatchObject({
        table: usersTable,
        set: {
          twitch_access_token: 'new-token',
          twitch_refresh_token: 'new-refresh-token',
          twitch_token_expires_at: expect.any(String),
          twitch_scopes: ['user:read:email'],
        },
      })
      expect(fixture.updateCalls[0].where).toEqual(and(
        eq(usersTable.twitch_user_id, 'user-1'),
        eq(usersTable.twitch_refresh_token, 'refresh-token'),
      ))
    })

    it('同じユーザーの並行refreshは両方ともendpointを呼び、CAS loserはwinnerを再読込する', async () => {
      vi.mocked(refreshTwitchToken)
        .mockResolvedValueOnce({ ...refreshedTokens, access_token: 'winner', refresh_token: 'winner-refresh', scope: ['winner:scope'] })
        .mockResolvedValueOnce({ ...refreshedTokens, access_token: 'loser', refresh_token: 'loser-refresh', scope: ['loser:scope'] })
      const fixture = createDrizzleDbMock({
        selects: [
          { rows: [userTokenRow(pastIso())] },
          { rows: [userTokenRow(pastIso())] },
          { rows: [{ twitch_access_token: 'winner' }] },
        ],
        updates: [{ rows: [{ twitch_access_token: 'winner' }] }, { rows: [] }],
      })
      primeDb(fixture)

      await expect(Promise.all([
        getTwitchAccessToken('user-1'),
        getTwitchAccessToken('user-1'),
      ])).resolves.toEqual(['winner', 'winner'])

      expect(refreshTwitchToken).toHaveBeenCalledTimes(2)
      expect(fixture.updateCalls).toHaveLength(2)
      for (const call of fixture.updateCalls) {
        expect(call.where).toEqual(and(
          eq(usersTable.twitch_user_id, 'user-1'),
          eq(usersTable.twitch_refresh_token, 'refresh-token'),
        ))
      }
      // loserのscopeだけを保存する第3 UPDATE は存在しない。
      expect(fixture.updateCalls).toHaveLength(2)
    })

    it('未デプロイ列(42703)は監視ログを残してnull、それ以外のDB障害はDATABASE_ERRORにする', async () => {
      const missingColumnError = { code: '42703', message: 'column missing' }
      const missingColumn = createDrizzleDbMock({
        selects: [{ error: missingColumnError }],
      })
      primeDb(missingColumn)
      await expect(getTwitchAccessToken('user-1')).resolves.toBeNull()
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Twitch token columns are missing; denying token access',
        { twitchUserId: 'user-1', error: missingColumnError },
      )

      const broken = createDrizzleDbMock({
        selects: [{ error: new Error('database unavailable') }],
      })
      primeDb(broken)
      await expect(getTwitchAccessToken('user-1')).rejects.toMatchObject({
        name: 'TwitchTokenError',
        code: 'DATABASE_ERROR',
      } satisfies Partial<TwitchTokenError>)
    })
  })

  describe('トークン・スコープ書き込み', () => {
    it('saveTwitchTokens は3列を更新し、deleteTwitchTokens は同じ3列を null にする', async () => {
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
        },
      })
      expect(fixture.updateCalls[1]).toMatchObject({
        table: usersTable,
        set: {
          twitch_access_token: null,
          twitch_refresh_token: null,
          twitch_token_expires_at: null,
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

    it('hasScope は列欠落時にfalseへ倒し、logger.errorで監視可能にする', async () => {
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
      expect(fixture.updateCalls[0]).toMatchObject({
        table: twitchBotAccountsTable,
        set: {
          twitch_access_token: 'new-token',
          twitch_refresh_token: 'new-refresh-token',
          twitch_token_expires_at: expect.any(String),
          scopes: ['user:read:email'],
          status: 'active',
          last_error: null,
        },
      })
      expect(fixture.updateCalls[0].where).toEqual(and(
        eq(twitchBotAccountsTable.id, 'bot-account-1'),
        eq(twitchBotAccountsTable.twitch_refresh_token, 'bot-refresh-token'),
      ))
    })

    it('同じBOTの並行refreshはCAS loserがwinner tokenを再読込し、scopeを巻き戻さない', async () => {
      vi.mocked(refreshTwitchToken)
        .mockResolvedValueOnce({ ...refreshedTokens, access_token: 'winner-bot', refresh_token: 'winner-bot-refresh', scope: ['winner:scope'] })
        .mockResolvedValueOnce({ ...refreshedTokens, access_token: 'loser-bot', refresh_token: 'loser-bot-refresh', scope: ['loser:scope'] })
      const expired = botAccountRow(pastIso())
      const fixture = createDrizzleDbMock({
        selects: [
          // 各 await の直後にもう一方のリクエストが進むため、同じテーブルの
          // 2 reads が先に消費される実際の interleave をキューで表す。
          { rows: [{ id: 'streamer-1' }] }, { rows: [{ id: 'streamer-1' }] },
          { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
          { rows: [{ sender_mode: 'custom_bot', custom_bot_account_id: 'bot-account-1' }] },
          { rows: [expired] }, { rows: [expired] },
          { rows: [{ twitch_access_token: 'winner-bot' }] },
        ],
        updates: [{ rows: [{ twitch_access_token: 'winner-bot' }] }, { rows: [] }],
      })
      primeDb(fixture)

      const results = await Promise.all([
        getBotAccountForChat('broadcaster-1'),
        getBotAccountForChat('broadcaster-2'),
      ])

      expect(refreshTwitchToken).toHaveBeenCalledTimes(2)
      expect(results.map(result => result?.accessToken)).toEqual(['winner-bot', 'winner-bot'])
      expect(fixture.updateCalls).toHaveLength(2)
      for (const call of fixture.updateCalls) {
        expect(call.where).toEqual(and(
          eq(twitchBotAccountsTable.id, 'bot-account-1'),
          eq(twitchBotAccountsTable.twitch_refresh_token, 'bot-refresh-token'),
        ))
      }
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
      expect(fixture.updateCalls[0]).toMatchObject({
        table: twitchBotAccountsTable,
        set: { status: 'error', last_error: 'token_refresh_failed' },
      })
      expect(fixture.updateCalls[0].where).toEqual(and(
        eq(twitchBotAccountsTable.id, 'bot-account-1'),
        eq(twitchBotAccountsTable.twitch_refresh_token, 'bot-refresh-token'),
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
      expect(fixture.updateCalls).toHaveLength(0)
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
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
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
