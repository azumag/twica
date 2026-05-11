import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/twitch/eventsub/route'
import { reportError } from '@/lib/sentry/error-handler'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { broadcastGachaResult } from '@/lib/realtime'
import { TwitchChatService } from '@/lib/twitch/chat-service'
import { hasScope } from '@/lib/twitch/token-manager'

const mocks = vi.hoisted(() => ({
  executeGachaForEventSub: vi.fn(),
  buildMessage: vi.fn((template: string | null, placeholders: { user: string; card: string; cards?: string; draws?: number }) => {
    const messageTemplate = template || '{user} got {card}'
    return messageTemplate
      .replace(/\{user\}/g, placeholders.user)
      .replace(/\{card\}/g, placeholders.card)
      .replace(/\{cards\}/g, placeholders.cards ?? '')
      .replace(/\{draws\}/g, placeholders.draws === undefined ? '' : String(placeholders.draws))
      .replace(/\s+/g, ' ')
      .trim()
  }),
  sendChatMessage: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/services/gacha', () => ({
  GachaService: vi.fn().mockImplementation(() => ({
    executeGachaForEventSub: mocks.executeGachaForEventSub,
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

vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn().mockResolvedValue(true),
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
const mockHasScope = vi.mocked(hasScope)

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
    mockHasScope.mockResolvedValue(true)
    mocks.buildMessage.mockImplementation((template: string | null, placeholders: { user: string; card: string; cards?: string; draws?: number }) => {
      const messageTemplate = template || '{user} got {card}'
      return messageTemplate
        .replace(/\{user\}/g, placeholders.user)
        .replace(/\{card\}/g, placeholders.card)
        .replace(/\{cards\}/g, placeholders.cards ?? '')
        .replace(/\{draws\}/g, placeholders.draws === undefined ? '' : String(placeholders.draws))
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
          chat_announcement_template: '{user}: first={card} all={cards} count={draws}',
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
      '{user}: first={card} all={cards} count={draws}',
      expect.objectContaining({
        user: 'Viewer',
        card: 'Alpha',
        cards: 'Alpha、Beta、Gamma',
        draws: 3,
      }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(
      'broadcaster-1',
      'Viewer: first=Alpha all=Alpha、Beta、Gamma count=3',
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
          chat_announcement_template: '@{user} が{draws}連ガチャで {cards} を獲得しました！',
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
})
