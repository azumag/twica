import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/twitch/eventsub/route'
import { reportError } from '@/lib/sentry/error-handler'
import { getSupabaseAdmin } from '@/lib/supabase/admin'

const mocks = vi.hoisted(() => ({
  executeGachaForEventSub: vi.fn(),
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
  hasScope: vi.fn(),
}))

vi.mock('@/lib/twitch/chat-service', () => ({
  DEFAULT_CHAT_TEMPLATE: '{user} got {card}',
  TwitchChatService: vi.fn(),
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
})
