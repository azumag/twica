import { beforeEach, describe, expect, it, vi } from 'vitest'
import { postRedemptionNotify, type RedemptionNotifyData } from '@/lib/services/eventsub-redemption'

/**
 * Issue #1665: postRedemptionNotifyのchat処理は、新しいbounded配送経路
 * （enqueueのみ）と既存の同期全件送信経路のどちらを使うかを、
 * enqueueChatNotificationWakeup単体の戻り値（outcome）だけで分岐する
 * （isChatDeliveryDispatchEnabled()を別途呼ばない。呼ぶとCloudflare Workers
 * 実行コンテキストの解決をガチャ交換のたびに倍加させてしまうため）。
 * outcome==='disabled'（フラグ未設定=初期状態）の場合だけ既存の同期経路
 * （claimChatNotificationBatchを呼ぶ）へ落ちる。'enqueued'/'unavailable'は
 * どちらも新経路が有効であることを意味し、同期経路は一切呼ばない
 * （'unavailable'＝Queue未配備でも、outbox行はpendingのまま残り既存の
 * Cron relayに委ねる。旧長時間ループへは自動フォールバックしない）。
 */

vi.mock('@/lib/services/chat-notification-outbox', () => ({
  claimChatNotificationBatch: vi.fn(),
  decodeChatNotificationPayload: vi.fn(),
  deadLetterChatNotification: vi.fn(),
  markChatNotificationSent: vi.fn(),
  renewChatNotificationLease: vi.fn(),
  retryChatNotification: vi.fn(),
}))

vi.mock('@/lib/services/chat-notification-dispatch', () => ({
  enqueueChatNotificationWakeup: vi.fn(),
}))

vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishCommittedGachaBatch: vi.fn().mockResolvedValue({ outcome: 'skipped', attempts: 0 }),
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { claimChatNotificationBatch } from '@/lib/services/chat-notification-outbox'
import { enqueueChatNotificationWakeup } from '@/lib/services/chat-notification-dispatch'

const mockClaim = vi.mocked(claimChatNotificationBatch)
const mockEnqueue = vi.mocked(enqueueChatNotificationWakeup)

const streamer = {
  id: 'streamer-1',
  chat_announcement_enabled: true,
  chat_announcement_template: '{user} got {card}',
  chat_announcement_multi_template: null,
  chat_announcement_multi_show_cards: false,
}

const card = {
  id: 'card-1',
  name: 'Alpha',
  description: null,
  image_url: null,
  rarity: 'common',
  drop_rate: 1,
}

const notifyData: RedemptionNotifyData = {
  gachaResult: { type: 'gacha', card, userTwitchUsername: 'Viewer' },
  broadcasterTwitchUserId: '130871908',
  streamer,
  userId: 'viewer-1',
  batchId: 'batch-1',
}

describe('postRedemptionNotify dispatch-flag branching (Issue #1665)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the existing synchronous claim path unchanged when enqueue reports disabled (初期状態)', async () => {
    mockEnqueue.mockResolvedValue({ outcome: 'disabled' })
    mockClaim.mockResolvedValue(null) // クレーム失敗として即returnさせ、以降の同期送信ロジックは対象外にする

    await postRedemptionNotify(notifyData)

    expect(mockEnqueue).toHaveBeenCalledWith('batch-1')
    expect(mockClaim).toHaveBeenCalledWith('batch-1')
  })

  it('skips the synchronous claim path once enqueue reports enqueued', async () => {
    mockEnqueue.mockResolvedValue({ outcome: 'enqueued' })

    await postRedemptionNotify(notifyData)

    expect(mockEnqueue).toHaveBeenCalledWith('batch-1')
    expect(mockClaim).not.toHaveBeenCalled()
  })

  it('also skips the synchronous claim path when the flag is on but the queue is unavailable (no silent fallback to the old loop)', async () => {
    mockEnqueue.mockResolvedValue({ outcome: 'unavailable', reason: 'queue-binding-missing' })

    await expect(postRedemptionNotify(notifyData)).resolves.toBeUndefined()

    expect(mockClaim).not.toHaveBeenCalled()
  })

  it('never calls enqueue when chat announcements are disabled for the streamer', async () => {
    await postRedemptionNotify({
      ...notifyData,
      streamer: { ...streamer, chat_announcement_enabled: false },
    })

    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockClaim).not.toHaveBeenCalled()
  })
})
