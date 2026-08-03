import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@/lib/db/client'
import {
  streamers as streamersTable,
  twitchBotAccounts as twitchBotAccountsTable,
} from '@/lib/db/schema'
import { logger } from '@/lib/logger.server'
import {
  getChatDeliveryCapability,
  resolveChatDeliveryCapability,
} from '@/lib/twitch/chat-delivery-capability'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * findChatDeliverySettings（streamers×users×streamerChatSenderSettingsのJOIN）と
 * hasActiveConfiguredBot（twitchBotAccountsのEXISTS確認）の2クエリを、from()に渡された
 * テーブルで判別して別々のfixture行を返すDrizzle query builderスタブ。
 *
 * 実装側の呼び出し順（settings取得 → 条件成立時のみbot照会）に依存せず、
 * from(table)を見て応答を出し分けるため、bot照会が「呼ばれなかったこと」を
 * fromTablesの内容で直接検証できる（呼び出し回数だけでは「呼ばれていない」を
 * 誤って合格させる可能性があるため、テーブル単位のトレースを残す）。
 */
function createDeliveryDb(config: {
  settingsRows?: Array<Record<string, unknown>>
  botRows?: Array<Record<string, unknown>>
} = {}) {
  const settingsRows = config.settingsRows ?? []
  const botRows = config.botRows ?? []
  const fromTables: unknown[] = []

  const db = {
    select: vi.fn(() => {
      const builder: any = {
        _table: undefined as unknown,
        from: vi.fn((table: unknown) => {
          builder._table = table
          fromTables.push(table)
          return builder
        }),
        leftJoin: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (onFulfilled: any, onRejected: any) => {
          const rows = builder._table === twitchBotAccountsTable ? botRows : settingsRows
          return Promise.resolve(rows).then(onFulfilled, onRejected)
        },
      }
      return builder
    }),
  }

  return { db, fromTables }
}

function primeDeliveryDb(fixture: { db: unknown }) {
  vi.mocked(getDb).mockResolvedValue({ db: fixture.db, sql: {} } as any)
}

const CHAT_WRITE_SCOPE = 'user:write:chat'

describe('resolveChatDeliveryCapability', () => {
  it('通知が無効なら送信手段がなくてもattentionにしない', () => {
    expect(resolveChatDeliveryCapability({
      chatAnnouncementEnabled: false,
      hasStoredScope: false,
      hasActiveBot: false,
    })).toMatchObject({ canSendChat: false, needsAttention: false })
  })

  it('本人の保存scopeがあれば送信可能', () => {
    expect(resolveChatDeliveryCapability({
      chatAnnouncementEnabled: true,
      hasStoredScope: true,
      hasActiveBot: false,
    })).toMatchObject({ canSendChat: true, needsAttention: false })
  })

  it('本人scopeがなくてもactive Botがあれば送信可能', () => {
    expect(resolveChatDeliveryCapability({
      chatAnnouncementEnabled: true,
      hasStoredScope: false,
      hasActiveBot: true,
    })).toMatchObject({ canSendChat: true, needsAttention: false })
  })

  it('通知有効かつ本人scopeもactive Botもなければattention', () => {
    expect(resolveChatDeliveryCapability({
      chatAnnouncementEnabled: true,
      hasStoredScope: false,
      hasActiveBot: false,
    })).toMatchObject({ canSendChat: false, needsAttention: true })
  })

  it('設定query失敗時は送信不能と断定せずattentionにしない', async () => {
    // 取得失敗は capability が「不明」の状態であり、正常に不足を確認した結果とは
    // 区別する。ここで false-positive を防ぐと、同じhelperを使うdashboard bannerと
    // settings sidebarの両方が一貫して非警告になる。
    vi.mocked(getDb).mockRejectedValueOnce(new Error('database unavailable'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

    await expect(getChatDeliveryCapability('query-failure-user')).resolves.toMatchObject({
      canSendChat: false,
      needsAttention: false,
    })
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to resolve chat delivery capability for dashboard',
      expect.objectContaining({
        broadcasterTwitchUserId: 'query-failure-user',
        error: 'database unavailable',
      }),
    )
  })
})

describe('getChatDeliveryCapability (DB分岐)', () => {
  it('streamers行が見つからなければ全てfalseでattentionにしない', async () => {
    const fixture = createDeliveryDb({ settingsRows: [] })
    primeDeliveryDb(fixture)

    await expect(getChatDeliveryCapability('no-streamer-user')).resolves.toEqual({
      chatAnnouncementEnabled: false,
      hasStoredScope: false,
      hasActiveBot: false,
      canSendChat: false,
      needsAttention: false,
    })
    // settingsクエリだけが発行され、bot照会（twitchBotAccountsTable）は走らない。
    expect(fixture.fromTables).toEqual([streamersTable])
  })

  it('chat_announcement_enabled=falseならbot照会を発行せずneedsAttentionにしない（保存scopeはhasStoredScopeへ反映）', async () => {
    const fixture = createDeliveryDb({
      settingsRows: [{
        streamerId: 'streamer-1',
        chatAnnouncementEnabled: false,
        twitchScopes: [CHAT_WRITE_SCOPE],
        senderMode: null,
        customBotAccountId: null,
      }],
    })
    primeDeliveryDb(fixture)

    await expect(getChatDeliveryCapability('disabled-user')).resolves.toEqual({
      chatAnnouncementEnabled: false,
      hasStoredScope: true,
      hasActiveBot: false,
      canSendChat: true,
      needsAttention: false,
    })
    // 無効時はhasActiveConfiguredBot自体を呼ばないため、bot照会が一切発行されない。
    expect(fixture.fromTables).toEqual([streamersTable])
  })

  it('enabled=true・scopeなし・custom_bot設定＋activeなbot行ありならhasActiveBot=trueでneedsAttentionにしない', async () => {
    const fixture = createDeliveryDb({
      settingsRows: [{
        streamerId: 'streamer-1',
        chatAnnouncementEnabled: true,
        twitchScopes: null,
        senderMode: 'custom_bot',
        customBotAccountId: 'bot-account-1',
      }],
      botRows: [{ id: 'bot-account-1' }],
    })
    primeDeliveryDb(fixture)

    await expect(getChatDeliveryCapability('custom-bot-active-user')).resolves.toEqual({
      chatAnnouncementEnabled: true,
      hasStoredScope: false,
      hasActiveBot: true,
      canSendChat: true,
      needsAttention: false,
    })
    expect(fixture.fromTables).toEqual([streamersTable, twitchBotAccountsTable])
  })

  it('enabled=true・scopeなし・custom_bot設定だがbot行なし(inactive)ならhasActiveBot=falseでneedsAttention', async () => {
    const fixture = createDeliveryDb({
      settingsRows: [{
        streamerId: 'streamer-1',
        chatAnnouncementEnabled: true,
        twitchScopes: null,
        senderMode: 'custom_bot',
        customBotAccountId: 'bot-account-1',
      }],
      botRows: [],
    })
    primeDeliveryDb(fixture)

    await expect(getChatDeliveryCapability('custom-bot-inactive-user')).resolves.toEqual({
      chatAnnouncementEnabled: true,
      hasStoredScope: false,
      hasActiveBot: false,
      canSendChat: false,
      needsAttention: true,
    })
  })

  it('enabled=true・scopeなし・official_bot設定＋activeなsystem bot行ありならhasActiveBot=true', async () => {
    const fixture = createDeliveryDb({
      settingsRows: [{
        streamerId: 'streamer-1',
        chatAnnouncementEnabled: true,
        twitchScopes: null,
        senderMode: 'official_bot',
        customBotAccountId: null,
      }],
      botRows: [{ id: 'system-bot-1' }],
    })
    primeDeliveryDb(fixture)

    await expect(getChatDeliveryCapability('official-bot-active-user')).resolves.toEqual({
      chatAnnouncementEnabled: true,
      hasStoredScope: false,
      hasActiveBot: true,
      canSendChat: true,
      needsAttention: false,
    })
  })

  it('enabled=true・scopeあり(CHAT_WRITE含む)・sender_modeなしならhasStoredScope=trueでcanSendChat=true・needsAttentionにしない', async () => {
    const fixture = createDeliveryDb({
      settingsRows: [{
        streamerId: 'streamer-1',
        chatAnnouncementEnabled: true,
        twitchScopes: [CHAT_WRITE_SCOPE, 'user:read:email'],
        senderMode: null,
        customBotAccountId: null,
      }],
    })
    primeDeliveryDb(fixture)

    await expect(getChatDeliveryCapability('stored-scope-user')).resolves.toEqual({
      chatAnnouncementEnabled: true,
      hasStoredScope: true,
      hasActiveBot: false,
      canSendChat: true,
      needsAttention: false,
    })
  })

  it.each([
    ['streamer' as const],
    [null],
  ])('enabled=true・scopeなし・sender_mode=%sならneedsAttention', async (senderMode) => {
    const fixture = createDeliveryDb({
      settingsRows: [{
        streamerId: 'streamer-1',
        chatAnnouncementEnabled: true,
        twitchScopes: null,
        senderMode,
        customBotAccountId: null,
      }],
    })
    primeDeliveryDb(fixture)

    await expect(getChatDeliveryCapability(`sender-mode-${String(senderMode)}-user`)).resolves.toEqual({
      chatAnnouncementEnabled: true,
      hasStoredScope: false,
      hasActiveBot: false,
      canSendChat: false,
      needsAttention: true,
    })
  })
})
