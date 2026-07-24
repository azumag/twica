import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/twitch/eventsub/route'
import { reportError } from '@/lib/sentry/error-handler'
import { getSupabaseAdmin, getSupabaseAdminNoCache } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { publishCommittedGachaBatch } from '@/lib/overlay-realtime/publisher'
import { TwitchChatService } from '@/lib/twitch/chat-service'

const mocks = vi.hoisted(() => ({
  executeGachaForEventSub: vi.fn(),
  executeGachaForRaidEvent: vi.fn(),
  buildMessage: vi.fn((template: string | null, placeholders: { user: string; card: string; cards?: string; draws?: number; rarityCounts?: string; newCards?: string; newCardCount?: number }) => {
    const messageTemplate = template || '{user} got {card}'
    return messageTemplate
      .replace(/\{user\}/g, placeholders.user)
      .replace(/\{card\}/g, placeholders.card)
      .replace(/\{cards\}/g, placeholders.cards ?? '')
      .replace(/\{draws\}/g, placeholders.draws === undefined ? '' : String(placeholders.draws))
      .replace(/\{rarityCounts\}/g, placeholders.rarityCounts ?? '')
      .replace(/\{newCards\}/g, placeholders.newCards ?? '')
      .replace(/\{newCardCount\}/g, placeholders.newCardCount === undefined ? '' : String(placeholders.newCardCount))
      .replace(/\s+/g, ' ')
      .trim()
  }),
  sendChatMessage: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/services/gacha', () => ({
  GachaService: vi.fn().mockImplementation(() => ({
    executeGachaForEventSub: mocks.executeGachaForEventSub,
    executeGachaForRaidEvent: mocks.executeGachaForRaidEvent,
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(),
  getSupabaseAdminNoCache: vi.fn(),
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(() => '127.0.0.1'),
  rateLimits: { eventsub: {} },
}))

vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishCommittedGachaBatch: vi.fn().mockResolvedValue({
    outcome: 'accepted',
    attempts: 1,
  }),
}))

vi.mock('@/lib/twitch/chat-service', () => ({
  DEFAULT_CHAT_TEMPLATE: '{user} got {card}',
  TwitchChatService: vi.fn().mockImplementation(() => ({
    buildMessage: mocks.buildMessage,
    sendChatMessage: mocks.sendChatMessage,
  })),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockGetSupabaseAdmin = vi.mocked(getSupabaseAdmin)
const mockGetSupabaseAdminNoCache = vi.mocked(getSupabaseAdminNoCache)
const mockReportError = vi.mocked(reportError)
const mockPublishCommittedGachaBatch = vi.mocked(publishCommittedGachaBatch)
const mockTwitchChatService = vi.mocked(TwitchChatService)

/**
 * チャット通知の「初出」判定は、ガチャ確定後の最終所持数をPlanetScale上の
 * get_user_card_countsから読む。旧NoCache RPC fixtureを残すとクエリ失敗が
 * 通知用の空値へ安全に縮退し、テストが意図する初出条件を検証できないため、
 * PostgreSQL関数のJSONB戻り値と同じ `[{ result: rows }]` をSQLタグへ返す。
 */
function mockUserCardCountRows(
  rows: Array<{ count: number; card: { id: string; is_active: boolean } }>,
) {
  const sql = vi.fn().mockResolvedValue([{ result: rows }])
  vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sql as never })
  return sql
}

async function signEventSubBody(secret: string, messageId: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(messageId + timestamp + body))
  return `sha256=${Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`
}

async function createNotificationRequest(gachaError: string): Promise<NextRequest> {
  const secret = 'eventsub-test-secret'
  process.env.TWITCH_EVENTSUB_SECRET = secret
  const messageId = `eventsub-${gachaError.replaceAll(' ', '-').toLowerCase()}`
  const timestamp = '2026-05-11T10:00:00Z'
  const body = JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'viewer-1',
      user_login: 'viewer',
      user_name: 'Viewer',
      reward: { id: 'stale-reward', title: 'Old Gacha', cost: 100 },
    },
  })
  const signature = await signEventSubBody(secret, messageId, timestamp, body)

  mocks.executeGachaForEventSub.mockResolvedValue({
    success: false,
    error: gachaError,
  })

  return new NextRequest('http://localhost:3000/api/twitch/eventsub', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-signature': signature,
    },
    body,
  })
}

describe('EventSub reward mismatch handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildMessage.mockImplementation((template: string | null, placeholders: { user: string; card: string; cards?: string; draws?: number; rarityCounts?: string; newCards?: string; newCardCount?: number }) => {
      const messageTemplate = template || '{user} got {card}'
      return messageTemplate
        .replace(/\{user\}/g, placeholders.user)
        .replace(/\{card\}/g, placeholders.card)
        .replace(/\{cards\}/g, placeholders.cards ?? '')
        .replace(/\{draws\}/g, placeholders.draws === undefined ? '' : String(placeholders.draws))
        .replace(/\{rarityCounts\}/g, placeholders.rarityCounts ?? '')
        .replace(/\{newCards\}/g, placeholders.newCards ?? '')
        .replace(/\{newCardCount\}/g, placeholders.newCardCount === undefined ? '' : String(placeholders.newCardCount))
        .replace(/\s+/g, ' ')
        .trim()
    })
    mocks.sendChatMessage.mockResolvedValue(true)
    const historyQuery = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    }
    mockGetSupabaseAdmin.mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'gacha_history') return historyQuery
        throw new Error(`Unexpected table: ${table}`)
      }),
    } as unknown as ReturnType<typeof getSupabaseAdmin>)
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)
    // 各テストを独立させ、前のケースの最終所持数fixtureを持ち越さない。
    mockUserCardCountRows([])
  })

  it('does not report stale EventSub notifications for unconfigured rewards', async () => {
    const response = await POST(await createNotificationRequest('Reward ID mismatch'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(mockReportError).not.toHaveBeenCalled()
  })

  it('does not report raid-limited redemptions outside the active raid window', async () => {
    const response = await POST(await createNotificationRequest('Raid-limited reward inactive'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(mockReportError).not.toHaveBeenCalled()
  })

  it('gifts configured raid gacha draws to the incoming raider', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-channel-raid'
    const timestamp = '2026-05-12T00:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.raid' },
      event: {
        from_broadcaster_user_id: 'raider-1',
        from_broadcaster_user_login: 'raider',
        from_broadcaster_user_name: 'Raider',
        to_broadcaster_user_id: 'broadcaster-1',
        to_broadcaster_user_login: 'streamer',
        to_broadcaster_user_name: 'Streamer',
        viewers: 42,
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)
    const cards = [
      { id: 'card-1', name: 'Raid Card 1', description: null, image_url: null, rarity: 'common', drop_rate: 1 },
      { id: 'card-2', name: 'Raid Card 2', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
    ]
    mocks.executeGachaForRaidEvent.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards,
        userTwitchUsername: 'Raider',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: false,
          chat_announcement_template: null,
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(mocks.executeGachaForEventSub).not.toHaveBeenCalled()
    expect(mocks.executeGachaForRaidEvent).toHaveBeenCalledWith({
      to_broadcaster_user_id: 'broadcaster-1',
      from_broadcaster_user_id: 'raider-1',
      from_broadcaster_user_login: 'raider',
      from_broadcaster_user_name: 'Raider',
    }, messageId)
    expect(mockPublishCommittedGachaBatch).toHaveBeenCalledWith(
      'streamer-1',
      expect.objectContaining({
        card: cards[0],
        cards,
        userTwitchUsername: 'Raider',
      }),
      expect.any(Object),
    )
    expect(mockReportError).not.toHaveBeenCalled()
  })

  it('still reports database failures while checking additional rewards', async () => {
    const response = await POST(
      await createNotificationRequest('Database error checking additional reward: Database error: error code: 502'),
    )

    expect(response.status).toBe(200)
    expect(mockReportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        context: 'eventsub:handleRedemption',
        broadcasterUserId: 'broadcaster-1',
        gachaError: 'Database error checking additional reward: Database error: error code: 502',
      }),
    )
  })

  it('broadcasts all cards returned by a multi-draw EventSub redemption', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-multi-draw'
    const timestamp = '2026-05-12T00:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-reward', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)
    const cards = [
      { id: 'card-1', name: 'Card 1', description: null, image_url: null, rarity: 'common' },
      { id: 'card-2', name: 'Card 2', description: null, image_url: null, rarity: 'rare' },
      { id: 'card-3', name: 'Card 3', description: null, image_url: null, rarity: 'epic' },
    ]
    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards,
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: false,
          chat_announcement_template: null,
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    expect(mockPublishCommittedGachaBatch).toHaveBeenCalledWith(
      'streamer-1',
      expect.objectContaining({
        card: cards[0],
        cards,
        userTwitchUsername: 'Viewer',
      }),
      expect.any(Object),
    )
  })

  it('sends multi-draw chat announcements with all cards while preserving {card} as the first card', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-multi-draw-chat'
    const timestamp = '2026-05-11T10:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-gacha', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    const cards = [
      { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      { id: 'card-2', name: 'Beta', description: null, image_url: null, rarity: 'common', drop_rate: 1 },
      { id: 'card-3', name: 'Gamma', description: null, image_url: null, rarity: 'legendary', drop_rate: 1 },
    ] as const

    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards: [...cards],
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: null,
          chat_announcement_multi_template: '{user}: first={card} all={cards} count={draws} rarity={rarityCounts}',
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ received: true })
    expect(mockPublishCommittedGachaBatch).toHaveBeenCalledWith(
      'streamer-1',
      expect.objectContaining({ card: cards[0], cards: [...cards] }),
      expect.any(Object),
    )
    expect(mockTwitchChatService).toHaveBeenCalled()
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '{user}: first={card} all={cards} count={draws} rarity={rarityCounts}',
      expect.objectContaining({
        user: 'Viewer',
        card: 'Alpha',
        cards: 'Alpha、Beta、Gamma',
        draws: 3,
        rarityCounts: 'レジェンダリーx1、レアx1、コモンx1',
      }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      'broadcaster-1',
      'Viewer: first=Alpha all=Alpha、Beta、Gamma count=3 rarity=レジェンダリーx1、レアx1、コモンx1',
    )
  })

  it('uses the default multi-draw template when no dedicated template is configured', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-multi-draw-single-template'
    const timestamp = '2026-05-11T10:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-gacha', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    const cards = [
      { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      { id: 'card-2', name: 'Beta', description: null, image_url: null, rarity: 'common', drop_rate: 1 },
      { id: 'card-3', name: 'Gamma', description: null, image_url: null, rarity: 'legendary', drop_rate: 1 },
    ] as const

    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards: [...cards],
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: '@{user} が {card} を獲得しました！',
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      'broadcaster-1',
      '@Viewer が3連ガチャで レジェンダリーx1、レアx1、コモンx1 を獲得しました！Alpha、Beta、Gamma',
    )
  })

  it('appends newly obtained card names to the default multi-draw chat announcement', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-multi-draw-new-cards'
    const timestamp = '2026-05-11T10:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-gacha', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    const cards = [
      { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      { id: 'card-2', name: 'Beta', description: null, image_url: null, rarity: 'common', drop_rate: 1 },
      { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      { id: 'card-3', name: 'Gamma', description: null, image_url: null, rarity: 'legendary', drop_rate: 1 },
    ] as const

    mockUserCardCountRows([
      { count: 2, card: { id: 'card-1', is_active: true } },
      { count: 2, card: { id: 'card-2', is_active: true } },
      { count: 1, card: { id: 'card-3', is_active: true } },
    ])

    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards: [...cards],
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: null,
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      'broadcaster-1',
      '@Viewer が4連ガチャで レジェンダリーx1、レアx2、コモンx1 を獲得しました！Alpha、Beta、Alpha、Gamma 初出: Alpha、Gamma',
    )
  })

  it('exposes newly obtained card placeholders for custom multi-draw templates', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-multi-draw-new-placeholders'
    const timestamp = '2026-05-11T10:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-gacha', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    const cards = [
      { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      { id: 'card-2', name: 'Beta', description: null, image_url: null, rarity: 'common', drop_rate: 1 },
    ] as const

    mockUserCardCountRows([
      { count: 1, card: { id: 'card-1', is_active: true } },
      { count: 3, card: { id: 'card-2', is_active: true } },
    ])

    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards: [...cards],
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: null,
          chat_announcement_multi_template: '@{user}: new={newCards} count={newCardCount} all={cards}',
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user}: new={newCards} count={newCardCount} all={cards}',
      expect.objectContaining({
        newCards: 'Alpha',
        newCardCount: 1,
        cards: 'Alpha、Beta',
      }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      'broadcaster-1',
      '@Viewer: new=Alpha count=1 all=Alpha、Beta',
    )
  })

  it('abbreviates long multi-draw card lists before sending chat announcements', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-long-multi-draw-chat'
    const timestamp = '2026-05-11T10:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-gacha', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    const cards = Array.from({ length: 10 }, (_, index) => ({
      id: `card-${index + 1}`,
      name: `CardName${String(index + 1).padStart(2, '0')}-${'A'.repeat(60)}`,
      description: null,
      image_url: null,
      rarity: 'rare',
      drop_rate: 1,
    }))

    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards,
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: null,
          chat_announcement_multi_template: '@{user} が{draws}連ガチャで {cards} を獲得しました！',
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    const placeholders = mocks.buildMessage.mock.calls.at(-1)?.[1]
    expect(placeholders?.cards).toMatch(/ほか\d+枚（\d+\/10枚表示）/)
    expect(placeholders?.cards).not.toContain('...')
    const sentMessage = mocks.sendChatMessage.mock.calls.at(-1)?.[1] as string
    expect(sentMessage.length).toBeLessThanOrEqual(500)
    expect(sentMessage).toContain('10連ガチャ')
  })

  it('can send a rarity-count-only multi-draw chat announcement when card lists are disabled', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-multi-draw-rarity-summary'
    const timestamp = '2026-05-11T10:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-gacha', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    const cards = [
      { id: 'card-1', name: 'Rare A', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      { id: 'card-2', name: 'Rare B', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      { id: 'card-3', name: 'Common A', description: null, image_url: null, rarity: 'common', drop_rate: 1 },
    ] as const
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null })
    mockGetSupabaseAdminNoCache.mockReturnValue({
      rpc,
    } as unknown as ReturnType<typeof getSupabaseAdminNoCache>)

    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards: [...cards],
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: null,
          chat_announcement_multi_template: '@{user}: {draws}連 {rarityCounts} {cards}',
          chat_announcement_multi_show_cards: false,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    expect(mocks.buildMessage).toHaveBeenCalledWith(
      '@{user}: {draws}連 {rarityCounts} {cards}',
      expect.objectContaining({
        cards: undefined,
        newCards: undefined,
        newCardCount: undefined,
        draws: 3,
        rarityCounts: 'レアx2、コモンx1',
      }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      'broadcaster-1',
      '@Viewer: 3連 レアx2、コモンx1',
    )
    expect(rpc).not.toHaveBeenCalled()
  })

  // 「初出: ...」追記がメッセージ末尾切り（truncate）で消えないことを確認する。
  // 旧実装では {cards} 圧縮時に接尾辞分の予約をしていなかったため、500文字に
  // 張り付くと最終的に 「初出:」 部分が truncate で削られていた。
  // Verifies that the appended "初出: ..." suffix survives even when {cards} fills the limit.
  it('preserves the 「初出: ...」 suffix when card lists fill the message limit', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-new-cards-suffix-preserved'
    const timestamp = '2026-05-11T10:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-gacha', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    // 各カード名は十分長く、10連で全カードを並べると 500 文字を大幅に超える。
    // すべてのカードが新規取得（finalCount=1, currentDrawCount=1）になるよう設定。
    const cards = Array.from({ length: 10 }, (_, index) => ({
      id: `card-${index + 1}`,
      name: `NewCardName${String(index + 1).padStart(2, '0')}-${'B'.repeat(60)}`,
      description: null,
      image_url: null,
      rarity: 'rare',
      drop_rate: 1,
    }))

    mockUserCardCountRows(
      cards.map((card) => ({ count: 1, card: { id: card.id, is_active: true } })),
    )

    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards,
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: null,
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    const sentMessage = mocks.sendChatMessage.mock.calls.at(-1)?.[1] as string
    expect(sentMessage.length).toBeLessThanOrEqual(500)
    // 「初出:」セクションが truncate で末尾削除されていないこと
    expect(sentMessage).toContain(' 初出: ')
    // truncate サフィックス '...' で終わっていない（=「初出:」直後で打ち切られていない）
    expect(sentMessage.endsWith('...')).toBe(false)
  })

  // legacy fallback で user_cards の INSERT に失敗すると finalCount が 0 のまま
  // 返ってきて「初出」誤通知が起きるバグ。finalCount=0 のカードは「持っていない」ため
  // 「初出」とは扱わない。
  // Regression: when finalCount=0 the user does not actually own the card (legacy fallback
  // INSERT failed); it must NOT be announced as "初出".
  it('does not announce 「初出」 when finalCount is 0 due to legacy fallback insert failure', async () => {
    const secret = 'eventsub-test-secret'
    process.env.TWITCH_EVENTSUB_SECRET = secret
    const messageId = 'eventsub-new-cards-legacy-fallback-zero'
    const timestamp = '2026-05-11T10:00:00Z'
    const body = JSON.stringify({
      subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
      event: {
        broadcaster_user_id: 'broadcaster-1',
        user_id: 'viewer-1',
        user_login: 'viewer',
        user_name: 'Viewer',
        reward: { id: 'raid-gacha', title: 'Raid Gacha', cost: 500 },
      },
    })
    const signature = await signEventSubBody(secret, messageId, timestamp, body)

    const cards = [
      { id: 'card-1', name: 'Alpha', description: null, image_url: null, rarity: 'rare', drop_rate: 1 },
      { id: 'card-2', name: 'Beta', description: null, image_url: null, rarity: 'common', drop_rate: 1 },
    ] as const

    // Beta は legacy fallback で INSERT 失敗 -> count=0 が返る想定。
    // 旧実装では previousCount = 0 - 1 = -1 で「初出」誤通知。
    mockUserCardCountRows([
      { count: 1, card: { id: 'card-1', is_active: true } },
      { count: 0, card: { id: 'card-2', is_active: true } },
    ])

    mocks.executeGachaForEventSub.mockResolvedValue({
      success: true,
      data: {
        card: cards[0],
        cards: [...cards],
        userTwitchUsername: 'Viewer',
        streamer: {
          id: 'streamer-1',
          chat_announcement_enabled: true,
          chat_announcement_template: null,
          chat_announcement_multi_template: null,
          chat_announcement_multi_show_cards: true,
        },
      },
    })

    const response = await POST(new NextRequest('http://localhost:3000/api/twitch/eventsub', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': messageId,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-message-signature': signature,
      },
      body,
    }))

    expect(response.status).toBe(200)
    const sentMessage = mocks.sendChatMessage.mock.calls.at(-1)?.[1] as string
    // Alpha は finalCount=1 で「初出」対象、Beta は finalCount=0 なので除外。
    expect(sentMessage).toContain(' 初出: Alpha')
    // 末尾の「初出:」セクションに Beta が含まれていないことを厳密に確認
    const newCardSection = sentMessage.slice(sentMessage.indexOf(' 初出: '))
    expect(newCardSection).not.toContain('Beta')
  })
})
