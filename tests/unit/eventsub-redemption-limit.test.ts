import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@/lib/db/client'

// Issue #108 / PR #450: カード発行可能枚数の上限到達はストリーマーの設定運用上の正常イベントなので、
// EventSub の redemption ハンドラーで reportError (= GitHub Issue 化) を呼ばずに warn ログのみで終わること。
// We verify that limit_reached errors do not trigger reportError, while unrelated errors still do.
//
// Issue #544/#546: 上記の売り切れ確定後に、チャンネルポイント返還(cancelRedemption)と
// チャット通知(TwitchChatService.sendChatMessage)が正しい条件で呼ばれることも検証する。

const mocks = vi.hoisted(() => ({
  cancelRedemption: vi.fn(),
  sendChatMessage: vi.fn(),
  // streamers.select('chat_announcement_enabled') の返り値。テストごとに上書きする。
  // デフォルトはnull(=行なし)とし、既存テストの「チャット通知は送られない」挙動を維持する。
  streamerSettings: null as { chat_announcement_enabled: boolean } | null,
  getCloudflareContext: vi.fn(),
}))

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

vi.mock('@/lib/services/gacha', () => {
  return {
    GachaService: vi.fn(),
  }
})

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  // logger.server/error-handler双方から呼ばれる永続化境界を副作用なしで満たす。
  logErrorFromLogger: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishCommittedGachaBatch: vi.fn().mockResolvedValue({
    outcome: 'accepted',
    attempts: 1,
  }),
}))

vi.mock('@/lib/twitch/chat-service', () => ({
  TwitchChatService: vi.fn().mockImplementation(() => ({
    sendChatMessage: mocks.sendChatMessage,
  })),
  DEFAULT_CHAT_TEMPLATE: '',
}))

vi.mock('@/lib/twitch/token-manager', () => ({
  hasScope: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/twitch/channel-points', () => ({
  cancelRedemption: mocks.cancelRedemption,
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
  mocks.streamerSettings = null
  mocks.cancelRedemption.mockResolvedValue({ success: true })
  mocks.sendChatMessage.mockResolvedValue(true)
  // 予期しないガチャ失敗は503にせず、元のEventSub本文をKVへdurable parkして
  // Twitch再送による二重実行を避ける。既存のreportError検証はこの成功経路でも維持する。
  mocks.getCloudflareContext.mockResolvedValue({
    env: { RATE_LIMIT_KV: { put: vi.fn().mockResolvedValue(undefined) } },
  })
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockImplementation(() =>
            Promise.resolve(mocks.streamerSettings ? [mocks.streamerSettings] : [])
          ),
        })),
      })),
    })),
  }
  vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as never)
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

async function buildRedemptionRequest(messageId: string, redemptionId?: string): Promise<Request> {
  const body = JSON.stringify({
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: {
      // Twitch の実 payload では channel_points_custom_reward_redemption.add イベントに
      // redemption ID がトップレベルの `id` として含まれる。テストでは省略可能にして、
      // 「redemption id が無い場合は返還を試みない」ケースを再現できるようにする。
      ...(redemptionId ? { id: redemptionId } : {}),
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
  it("soldOut(発行可能枚数到達)を返した場合 reportError を呼ばず warn ログのみで 200 を返す", async () => {
    // 実際に GachaService.executeGacha / executeGachaForEventSub が返すのは
    // CARD_ISSUANCE_MESSAGES.soldOut であり、'limit_reached' という文字列
    // (RPCの内部フィールド名)がエラーとして返ることはない。past実装の
    // route.ts側の条件分岐に 'limit_reached' との文字列比較が残っていたが、
    // 実際には到達しないデッドコードだったため、実態に合わせて修正した
    // (#544/#546フォローアップでの気づき)。
    const { CARD_ISSUANCE_MESSAGES } = await import('@/lib/card-issuance')
    const { GachaService } = await import('@/lib/services/gacha')
    const { reportError } = await import('@/lib/sentry/error-handler')
    const mockReport = vi.mocked(reportError)
    const mockExecute = vi.fn().mockResolvedValue({ success: false, error: CARD_ISSUANCE_MESSAGES.soldOut })
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

  it('R2 (PR #450 follow-up) + #544/#546: レガシーフォールバックの拒否(limitUnavailable)は reportError も呼びつつ、視聴者への返還・チャット通知も行う', async () => {
    // execute_gacha_transaction RPC が未デプロイのまま limited カードが選ばれた
    // 場合、GachaService.executeGachaLegacy は CARD_ISSUANCE_MESSAGES.soldOut
    // ではなく専用の limitUnavailable を返す(src/lib/services/gacha.ts)。
    // これは「発行枚数上限に達した」という運用上正常な状態ではなく、
    // 「RPC関数が本番に存在しない」という本来あってはならない異常事態なので、
    // reportError で確実にアラートされることを検証する。
    // 一方で視聴者は soldOut のときと同様に既にチャンネルポイントを消費済みで
    // カードを受け取れていないため、reportError とは独立に #544/#546 の
    // 返還・チャット通知も必ず行われることを検証する(このガードが漏れていると、
    // 視聴者はポイントを失ったまま何の救済も受けられなくなる)。
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
    mocks.streamerSettings = { chat_announcement_enabled: true }
    mocks.cancelRedemption.mockResolvedValue({ success: true })

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-limit-unavailable-1', 'redemption-limit-unavailable-1')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mockReport).toHaveBeenCalledTimes(1)
    expect(mockReport).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'eventsub:handleRedemption:limitUnavailable' }),
    )
    expect(mocks.cancelRedemption).toHaveBeenCalledWith({
      broadcasterTwitchUserId: 'broadcaster-1',
      rewardId: 'reward-1',
      redemptionId: 'redemption-limit-unavailable-1',
    })
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1)
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

describe('EventSub redemption: sold-out chat notification + channel points refund (Issue #544, #546)', () => {
  async function mockSoldOut() {
    // 実際に返るのは CARD_ISSUANCE_MESSAGES.soldOut('このカードは発行可能枚数に
    // 達しています')。'limit_reached' は RPC の内部フィールド名であり
    // エラー文字列としては返らないため、実態に合わせて修正した。
    const { CARD_ISSUANCE_MESSAGES } = await import('@/lib/card-issuance')
    const { GachaService } = await import('@/lib/services/gacha')
    vi.mocked(GachaService).mockImplementation(() => ({
      executeGachaForEventSub: vi.fn().mockResolvedValue({ success: false, error: CARD_ISSUANCE_MESSAGES.soldOut }),
    }) as unknown as InstanceType<typeof GachaService>)
  }

  it('返還成功時: cancelRedemption が正しい引数で呼ばれ、返還済み文言でチャット通知される', async () => {
    await mockSoldOut()
    mocks.streamerSettings = { chat_announcement_enabled: true }
    mocks.cancelRedemption.mockResolvedValue({ success: true })

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-refund-success-1', 'redemption-1')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mocks.cancelRedemption).toHaveBeenCalledWith({
      broadcasterTwitchUserId: 'broadcaster-1',
      rewardId: 'reward-1',
      redemptionId: 'redemption-1',
    })
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1)
    const [broadcasterId, message] = mocks.sendChatMessage.mock.calls[0]
    expect(broadcasterId).toBe('broadcaster-1')
    expect(message).toContain('@Tester')
    expect(message).toContain('返還されました')
  })

  it('返還API失敗時: reportError で記録されるが例外を投げず200を返し、通常文言でチャット通知される', async () => {
    await mockSoldOut()
    mocks.streamerSettings = { chat_announcement_enabled: true }
    mocks.cancelRedemption.mockResolvedValue({ success: false, reason: 'http_401' })
    const { reportError } = await import('@/lib/sentry/error-handler')
    const mockReport = vi.mocked(reportError)

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-refund-fail-1', 'redemption-2')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    // 返還APIが失敗してもEventSubへのレスポンスは200のまま(クラッシュしない)
    expect(res.status).toBe(200)
    expect(mocks.cancelRedemption).toHaveBeenCalledTimes(1)
    // 返還失敗はSentry/Issue化のためreportErrorに記録される
    expect(mockReport).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'eventsub:postSoldOutNotify:cancelRedemption' }),
    )
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1)
    const [, message] = mocks.sendChatMessage.mock.calls[0]
    expect(message).not.toContain('返還されました')
  })

  it('返還失敗のreporter自体がrejectしても200応答とチャット通知を維持する', async () => {
    await mockSoldOut()
    mocks.streamerSettings = { chat_announcement_enabled: true }
    mocks.cancelRedemption.mockResolvedValue({ success: false, reason: 'http_503' })
    const { reportError } = await import('@/lib/sentry/error-handler')
    const { logger } = await import('@/lib/logger')
    vi.mocked(reportError).mockRejectedValueOnce(new Error('error reporter unavailable'))

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-reporter-fail-1', 'redemption-reporter-fail-1')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    // カード付与失敗後のポイント返還・通知はpost-commit処理であり、
    // 監視基盤の停止をEventSub再送やチャット欠落へ波及させない。
    expect(res.status).toBe(200)
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      '[EventSub] Failed to persist notification error',
      {
        context: 'eventsub:postSoldOutNotify:cancelRedemption',
        error: 'error reporter unavailable',
      },
    )
  })

  it('cancelRedemptionが例外をthrowしても200を返し、握りつぶされる', async () => {
    await mockSoldOut()
    mocks.streamerSettings = { chat_announcement_enabled: true }
    mocks.cancelRedemption.mockRejectedValue(new Error('network error'))

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-refund-throw-1', 'redemption-3')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    // 返還は失敗扱いなので通常文言でチャット通知は継続される
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1)
    const [, message] = mocks.sendChatMessage.mock.calls[0]
    expect(message).not.toContain('返還されました')
  })

  it('redemption id が無い場合: 返還は試みず、チャット通知のみ行われる', async () => {
    await mockSoldOut()
    mocks.streamerSettings = { chat_announcement_enabled: true }

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    // redemptionId を渡さない = event.id が payload に含まれないケース
    const req = await buildRedemptionRequest('msg-no-redemption-id-1')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mocks.cancelRedemption).not.toHaveBeenCalled()
    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(1)
  })

  it('chat_announcement_enabled が false の場合: 返還は試みるがチャット通知はしない', async () => {
    await mockSoldOut()
    mocks.streamerSettings = { chat_announcement_enabled: false }
    mocks.cancelRedemption.mockResolvedValue({ success: true })

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-chat-disabled-1', 'redemption-4')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mocks.cancelRedemption).toHaveBeenCalledTimes(1)
    expect(mocks.sendChatMessage).not.toHaveBeenCalled()
  })

  it('streamerSettings が無い(行なし)場合: 既存挙動どおりチャット通知しない', async () => {
    await mockSoldOut()
    mocks.streamerSettings = null

    const { POST } = await import('@/app/api/twitch/eventsub/route')
    const req = await buildRedemptionRequest('msg-no-streamer-row-1')
    const res = await POST(req as unknown as import('next/server').NextRequest)

    expect(res.status).toBe(200)
    expect(mocks.sendChatMessage).not.toHaveBeenCalled()
  })
})
