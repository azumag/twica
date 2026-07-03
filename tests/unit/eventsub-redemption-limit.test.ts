import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Issue #108 / PR #450: カード発行可能枚数の上限到達はストリーマーの設定運用上の正常イベントなので、
// EventSub の redemption ハンドラーで reportError (= GitHub Issue 化) を呼ばずに warn ログのみで終わること。
// We verify that limit_reached errors do not trigger reportError, while unrelated errors still do.

vi.mock('@/lib/services/gacha', () => {
  return {
    GachaService: vi.fn(),
  }
})

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
}))

vi.mock('@/lib/realtime', () => ({
  broadcastGachaResult: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/twitch/chat-service', () => ({
  TwitchChatService: vi.fn(),
  DEFAULT_CHAT_TEMPLATE: '',
}))

vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn().mockResolvedValue(true),
}))

// 既存履歴チェック (gacha_history.select.eq.maybeSingle) を「未処理」として返すための supabase admin モック。
// New event id → no existing history row → handleRedemption proceeds to gachaService call.
vi.mock('@/lib/supabase/admin', () => ({
  getSupabaseAdmin: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      })),
    })),
  })),
  getSupabaseAdminNoCache: vi.fn(),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, limit: 100, remaining: 99, reset: 0 }),
  rateLimits: { eventsub: {} },
  getClientIp: vi.fn(() => '127.0.0.1'),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const TEST_SECRET = 'test-eventsub-secret'

const ORIGINAL_SECRET = process.env.TWITCH_EVENTSUB_SECRET

beforeEach(() => {
  process.env.TWITCH_EVENTSUB_SECRET = TEST_SECRET
  vi.clearAllMocks()
})

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.TWITCH_EVENTSUB_SECRET
  } else {
    process.env.TWITCH_EVENTSUB_SECRET = ORIGINAL_SECRET
  }
})

/**
 * EventSub の HMAC 署名を計算するヘルパー。
 * Compute the HMAC-SHA256 signature exactly as Twitch does (messageId + timestamp + body).
 */
async function signMessage(messageId: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(TEST_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(messageId + timestamp + body))
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return 'sha256=' + hex
}

async function buildRedemptionRequest(messageId: string): Promise<Request> {
  const body = JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      broadcaster_user_id: 'broadcaster-1',
      user_id: 'user-1',
      user_login: 'tester',
      user_name: 'Tester',
      reward: { id: 'reward-1', title: 'Gacha', cost: 100 },
    },
  })
  const timestamp = new Date().toISOString()
  const signature = await signMessage(messageId, timestamp, body)
  return new Request('https://example.com/api/twitch/eventsub', {
    method: 'POST',
    headers: {
      'twitch-eventsub-message-id': messageId,
      'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-type': 'notification',
      'twitch-eventsub-message-signature': signature,
      'content-type': 'application/json',
    },
    body,
  })
}

describe('EventSub redemption: card issuance limit error handling', () => {
  it("limit_reached を返した場合 reportError を呼ばず warn ログのみで 200 を返す", async () => {
    const { GachaService } = await import('@/lib/services/gacha')
    const { reportError } = await import('@/lib/sentry/error-handler')
    const mockReport = vi.mocked(reportError)
    const mockExecute = vi.fn().mockResolvedValue({ success: false, error: 'limit_reached' })
    vi.mocked(GachaService).mockImplementation(() => ({
      executeGachaForEventSub: mockExecute,
    }) as unknown as InstanceType<typeof GachaService>)

    // route.ts は import 時に GachaService を読み込むため、モック確定後に動的 import する
    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-limit-1')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mockExecute).toHaveBeenCalled()
    expect(mockReport).not.toHaveBeenCalled()
  })

  it('日本語の発行可能枚数メッセージも reportError を呼ばない', async () => {
    const { GachaService } = await import('@/lib/services/gacha')
    const { reportError } = await import('@/lib/sentry/error-handler')
    const mockReport = vi.mocked(reportError)
    vi.mocked(GachaService).mockImplementation(() => ({
      executeGachaForEventSub: vi.fn().mockResolvedValue({
        success: false,
        error: 'このカードは発行可能枚数に達しています',
      }),
    }) as unknown as InstanceType<typeof GachaService>)

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-limit-2')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mockReport).not.toHaveBeenCalled()
  })

  it('R2 (PR #450 follow-up): レガシーフォールバックの拒否(limitUnavailable)は genuine soldOut と区別され reportError を呼ぶ', async () => {
    // execute_gacha_transaction RPC が未デプロイのまま limited カードが選ばれた
    // 場合、GachaService.executeGachaLegacy は CARD_ISSUANCE_MESSAGES.soldOut
    // ではなく専用の limitUnavailable を返す(src/lib/services/gacha.ts)。
    // これは「発行枚数上限に達した」という運用上正常な状態ではなく、
    // 「RPC関数が本番に存在しない」という本来あってはならない異常事態なので、
    // eventsub route のソフトフェイル抑止リストに含めず reportError を発火させ、
    // 確実にアラートされることを検証する。
    const { CARD_ISSUANCE_MESSAGES } = await import('@/lib/card-issuance')
    const { GachaService } = await import('@/lib/services/gacha')
    const { reportError } = await import('@/lib/sentry/error-handler')
    const mockReport = vi.mocked(reportError)
    vi.mocked(GachaService).mockImplementation(() => ({
      executeGachaForEventSub: vi.fn().mockResolvedValue({
        success: false,
        error: CARD_ISSUANCE_MESSAGES.limitUnavailable,
      }),
    }) as unknown as InstanceType<typeof GachaService>)

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-limit-unavailable-1')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mockReport).toHaveBeenCalledTimes(1)
  })

  it('limit_reached 以外のエラーは引き続き reportError を呼ぶ (回帰防止)', async () => {
    const { GachaService } = await import('@/lib/services/gacha')
    const { reportError } = await import('@/lib/sentry/error-handler')
    const mockReport = vi.mocked(reportError)
    vi.mocked(GachaService).mockImplementation(() => ({
      executeGachaForEventSub: vi.fn().mockResolvedValue({
        success: false,
        error: 'Database error: connection refused',
      }),
    }) as unknown as InstanceType<typeof GachaService>)

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-other-1')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mockReport).toHaveBeenCalledTimes(1)
  })
})
