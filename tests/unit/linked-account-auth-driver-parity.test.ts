/**
 * #572/#708: linked-account-authのPlanetScale経路テスト
 *
 * tests/unit/token-manager-driver-parity.test.ts と同じ流儀。書き込み系の要件どおり
 * 「pg 経路で正しいテーブル・values/set 内容・where/conflict 条件で INSERT/UPDATE/
 * upsert され、リダイレクト先（外部から見える戻り値）が postgrest 経路と一致する」
 * ことを検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { handleLinkedAccountCallback } from '@/lib/twitch/linked-account-auth'
import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { exchangeCodeForTokens, getTwitchUser } from '@/lib/twitch/auth'
import { getDb } from '@/lib/db/client'
import {
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
} from '@/lib/db/schema'

vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
}))
vi.mock('@/lib/twitch/auth', () => ({
  exchangeCodeForTokens: vi.fn(),
  getTwitchUser: vi.fn(),
  isInvalidAuthorizationCodeError: vi.fn(() => false),
}))
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// pg 経路のモック: select / update / insert (values / returning /
// onConflictDoUpdate) の各引数を記録する thenable builder
// ---------------------------------------------------------------------------

interface PgWriteCall {
  table: unknown
  values?: Record<string, unknown>
  set?: Record<string, unknown>
  where?: unknown
  returningSelection?: Record<string, unknown>
  onConflict?: { target: unknown; set: Record<string, unknown> }
}

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  updates?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
  inserts?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
} = {}) {
  let selectIndex = 0
  let updateIndex = 0
  let insertIndex = 0
  const updateCalls: PgWriteCall[] = []
  const insertCalls: PgWriteCall[] = []

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
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    update: vi.fn((table: unknown) => {
      const responses = config.updates ?? [{ rows: [{ id: 'bot-account-1' }] }]
      const response = responses[Math.min(updateIndex, responses.length - 1)]
      updateIndex += 1
      const call: PgWriteCall = { table }
      updateCalls.push(call)
      const resolve = () =>
        response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
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
          call.returningSelection = selection
          return resolve()
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
    insert: vi.fn((table: unknown) => {
      const responses = config.inserts ?? [{ rows: [{ id: 'bot-account-1' }] }]
      const response = responses[Math.min(insertIndex, responses.length - 1)]
      insertIndex += 1
      const call: PgWriteCall = { table }
      insertCalls.push(call)
      const resolve = () =>
        response.error ? Promise.reject(response.error) : Promise.resolve(response.rows ?? [])
      const builder: any = {
        values: vi.fn((values: Record<string, unknown>) => {
          call.values = values
          return builder
        }),
        returning: vi.fn((selection: Record<string, unknown>) => {
          call.returningSelection = selection
          return resolve()
        }),
        onConflictDoUpdate: vi.fn((cfg: { target: unknown; set: Record<string, unknown> }) => {
          call.onConflict = cfg
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, updateCalls, insertCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const BASE_URL = 'https://twica.example'
const CALLBACK_ARGS = { baseUrl: BASE_URL, code: 'auth-code', redirectUri: `${BASE_URL}/cb` }

const TOKENS = {
  access_token: 'bot-access',
  refresh_token: 'bot-refresh',
  expires_in: 3600,
  token_type: 'bearer',
  scope: ['user:write:chat'],
}

const BOT_USER = {
  id: 'bot-twitch-1',
  login: 'bot_user',
  display_name: 'Bot User',
  profile_image_url: '',
  broadcaster_type: '',
}

/** 両経路が永続化すべき BOT アカウントの共通フィールド */
const EXPECTED_BOT_FIELDS = {
  twitch_user_id: 'bot-twitch-1',
  twitch_username: 'bot_user',
  twitch_display_name: 'Bot User',
  twitch_access_token: 'bot-access',
  twitch_refresh_token: 'bot-refresh',
  twitch_token_expires_at: expect.any(String),
  scopes: ['user:write:chat'],
  status: 'active',
  last_error: null,
}

describe('handleLinkedAccountCallback: PlanetScale経路 (#572/#708)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSession).mockResolvedValue({ twitchUserId: 'streamer-twitch-1' } as any)
    vi.mocked(canUseStreamerFeatures).mockReturnValue(true)
    vi.mocked(exchangeCodeForTokens).mockResolvedValue(TOKENS)
    vi.mocked(getTwitchUser).mockResolvedValue(BOT_USER)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('新規接続: 正しいvaluesのINSERTとstreamer_id競合upsertを実行する', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'streamer-1' }] }, { rows: [] }],
    })
    primePgDb(pg)
    const pgRes = await handleLinkedAccountCallback(CALLBACK_ARGS)

    expect(pgRes.headers.get('location')).toBe(`${BASE_URL}/dashboard/settings?bot=connected`)

    // INSERT: twitch_bot_accounts へ owner_type / streamer_id 付きの values
    expect(pg.insertCalls).toHaveLength(2)
    expect(pg.insertCalls[0].table).toBe(twitchBotAccountsTable)
    expect(pg.insertCalls[0].values).toEqual({
      ...EXPECTED_BOT_FIELDS,
      owner_type: 'streamer',
      streamer_id: 'streamer-1',
    })
    expect(pg.insertCalls[0].returningSelection).toEqual({ id: twitchBotAccountsTable.id })

    // upsert: streamer_chat_sender_settings の conflict target は PK の streamer_id
    // （migration 00040: streamer_id UUID PRIMARY KEY。supabase-js の onConflict
    // 未指定 upsert と同じ衝突対象）
    expect(pg.insertCalls[1].table).toBe(streamerChatSenderSettingsTable)
    expect(pg.insertCalls[1].values).toEqual({
      streamer_id: 'streamer-1',
      sender_mode: 'custom_bot',
      custom_bot_account_id: 'bot-account-1',
    })
    expect(pg.insertCalls[1].onConflict?.target).toBe(streamerChatSenderSettingsTable.streamer_id)
    expect(pg.insertCalls[1].onConflict?.set).toEqual({
      sender_mode: 'custom_bot',
      custom_bot_account_id: 'bot-account-1',
    })
    // UPDATE は発生しない（新規のため）
    expect(pg.updateCalls).toHaveLength(0)
  })

  it('既存BOTの更新: 正しいset/whereでUPDATEする', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })

    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'streamer-1' }] }, { rows: [{ id: 'bot-existing-1' }] }],
      updates: [{ rows: [{ id: 'bot-existing-1' }] }],
    })
    primePgDb(pg)
    const pgRes = await handleLinkedAccountCallback(CALLBACK_ARGS)

    expect(pgRes.headers.get('location')).toBe(`${BASE_URL}/dashboard/settings?bot=connected`)

    // UPDATE: 既存行 id を where にした botAccountFields の全量 set
    expect(pg.updateCalls).toHaveLength(1)
    expect(pg.updateCalls[0].table).toBe(twitchBotAccountsTable)
    expect(pg.updateCalls[0].set).toEqual(EXPECTED_BOT_FIELDS)
    expect(pg.updateCalls[0].where).toEqual(eq(twitchBotAccountsTable.id, 'bot-existing-1'))
    expect(pg.updateCalls[0].returningSelection).toEqual({ id: twitchBotAccountsTable.id })

    // BOT の INSERT は発生せず、設定の upsert のみ
    expect(pg.insertCalls).toHaveLength(1)
    expect(pg.insertCalls[0].table).toBe(streamerChatSenderSettingsTable)
    expect(pg.insertCalls[0].values).toEqual({
      streamer_id: 'streamer-1',
      sender_mode: 'custom_bot',
      custom_bot_account_id: 'bot-existing-1',
    })
  })

  it('pg 経路の読み取りが既存実装と同じ条件（streamers.twitch_user_id / 既存 BOT の owner_type + streamer_id）で発行される', async () => {
    const pg = createDrizzleDbMock({
      selects: [{ rows: [{ id: 'streamer-1' }] }, { rows: [] }],
    })
    // where 引数を記録するため select builder を包む
    const whereArgs: unknown[] = []
    const originalSelect = pg.db.select
    pg.db.select = vi.fn((fields: Record<string, unknown>) => {
      const builder = originalSelect(fields)
      const originalWhere = builder.where
      builder.where = vi.fn((condition: unknown) => {
        whereArgs.push(condition)
        return originalWhere(condition)
      })
      return builder
    }) as any
    primePgDb(pg)

    await handleLinkedAccountCallback(CALLBACK_ARGS)

    expect(whereArgs[0]).toEqual(eq(streamersTable.twitch_user_id, 'streamer-twitch-1'))
    expect(whereArgs[1]).toEqual(
      and(
        eq(twitchBotAccountsTable.owner_type, 'streamer'),
        eq(twitchBotAccountsTable.streamer_id, 'streamer-1')
      )
    )
  })

  it('streamer不在はdatabase_errorへリダイレクトする', async () => {
    const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
    primePgDb(pg)
    const pgRes = await handleLinkedAccountCallback(CALLBACK_ARGS)

    expect(pgRes.headers.get('location')).toBe(
      `${BASE_URL}/dashboard/settings?bot_error=database_error`
    )
  })

  it('DBエラーはdatabase_errorに落ちる（外側catchのbot_auth_failedに化けない）', async () => {
    const pg = createDrizzleDbMock({
      selects: [{ error: { code: '42601', message: 'syntax error' } }],
    })
    primePgDb(pg)

    const res = await handleLinkedAccountCallback(CALLBACK_ARGS)

    expect(res.headers.get('location')).toBe(
      `${BASE_URL}/dashboard/settings?bot_error=database_error`
    )
  })

})
