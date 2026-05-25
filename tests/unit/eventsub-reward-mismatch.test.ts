import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/twitch/eventsub/route'
import { reportError } from '@/lib/sentry/error-handler'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { broadcastGachaResult } from '@/lib/realtime'
import { TwitchChatService } from '@/lib/twitch/chat-service'

const mocks = vi.hoisted(() => ({
  executeGachaForEventSub: vi.fn(),
  executeGachaForRaidEvent: vi.fn(),
  buildMessage: vi.fn((template: string | null, placeholders: { user: string; card: string; cards?: string; draws?: number; rarityCounts?: string }) => {
    const messageTemplate = template || '{user} got {card}'
    return messageTemplate
      .replace(/\{user\}/g, placeholders.user)
      .replace(/\{card\}/g, placeholders.card)
      .replace(/\{cards\}/g, placeholders.cards ?? '')
      .replace(/\{draws\}/g, placeholders.draws === undefined ? '' : String(placeholders.draws))
      .replace(/\{rarityCounts\}/g, placeholders.rarityCounts ?? '')
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

vi.mock('@/lib/realtime', () => ({
  broadcastGachaResult: vi.fn(),
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
const mockReportError = vi.mocked(reportError)
const mockBroadcastGachaResult = vi.mocked(broadcastGachaResult)
const mockTwitchChatService = vi.mocked(TwitchChatService)

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
    mocks.buildMessage.mockImplementation((template: string | null, placeholders: { user: string; card: string; cards?: string; draws?: number; rarityCounts?: string }) => {
      const messageTemplate = template || '{user} got {card}'
      return messageTemplate
        .replace(/\{user\}/g, placeholders.user)
        .replace(/\{card\}/g, placeholders.card)
        .replace(/\{cards\}/g, placeholders.cards ?? '')
        .replace(/\{draws\}/g, placeholders.draws === undefined ? '' : String(placeholders.draws))
        .replace(/\{rarityCounts\}/g, placeholders.rarityCounts ?? '')
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
    expect(mockBroadcastGachaResult).toHaveBeenCalledWith(
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
    expect(mockBroadcastGachaResult).toHaveBeenCalledWith(
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
    expect(mockBroadcastGachaResult).toHaveBeenCalledWith(
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
        draws: 3,
        rarityCounts: 'レアx2、コモンx1',
      }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      'broadcaster-1',
      '@Viewer: 3連 レアx2、コモンx1',
    )
  })
})
