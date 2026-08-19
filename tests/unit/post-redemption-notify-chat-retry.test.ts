import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postRedemptionNotify, type RedemptionNotifyData } from '@/lib/services/eventsub-redemption'
import { TwitchChatService } from '@/lib/twitch/chat-service'
import { reportError } from '@/lib/sentry/error-handler'
import { logger } from '@/lib/logger.server'
import {
  claimChatNotificationBatch,
  decodeChatNotificationPayload,
  retryChatNotification,
  markChatNotificationSent,
  deadLetterChatNotification,
} from '@/lib/services/chat-notification-outbox'

/**
 * Issue #1033: Twitch 429（レート制限）のような一時障害は
 * chat_notification_outbox が自動的に再試行するpending状態であり、正常系の
 * 一部である。にもかかわらず旧実装は retryState を問わず常にthrowしており、
 * postRedemptionNotify 呼び出し元の Promise.allSettled 経由で
 * reportError（[Error] 発報 → 自動Issue化）まで到達していた。
 * 本番で429が1回起きただけでGitHub Issueが自動作成されるノイズの原因になっていた。
 *
 * ここでは retryChatNotification の戻り値ごとに reportError が呼ばれるか/
 * 呼ばれないかを固定する:
 * - 'pending'（自動再試行予定）: reportErrorを呼ばずwarnログのみ
 * - 'dead'（再試行を使い切った）: 従来通りreportErrorを呼ぶ
 */

vi.mock('@/lib/services/chat-notification-outbox', () => ({
  claimChatNotificationBatch: vi.fn(),
  decodeChatNotificationPayload: vi.fn(),
  deadLetterChatNotification: vi.fn(),
  markChatNotificationSent: vi.fn(),
  renewChatNotificationLease: vi.fn(),
  retryChatNotification: vi.fn(),
}))

vi.mock('@/lib/overlay-realtime/publisher', () => ({
  publishCommittedGachaBatch: vi.fn().mockResolvedValue({ outcome: 'skipped', attempts: 0 }),
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/logger.server', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockClaim = vi.mocked(claimChatNotificationBatch)
const mockDecode = vi.mocked(decodeChatNotificationPayload)
const mockRetry = vi.mocked(retryChatNotification)
const mockMarkSent = vi.mocked(markChatNotificationSent)
const mockDeadLetter = vi.mocked(deadLetterChatNotification)
const mockReportError = vi.mocked(reportError)
const mockLoggerWarn = vi.mocked(logger.warn)

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
  gachaResult: {
    type: 'gacha',
    card,
    userTwitchUsername: 'Viewer',
  },
  broadcasterTwitchUserId: '130871908',
  streamer,
  userId: 'viewer-1',
  batchId: 'batch-1',
}

const claim = {
  id: 'outbox-1',
  batchId: 'batch-1',
  payloadVersion: 1,
  payload: {},
  leaseId: 'lease-1',
  attemptCount: 1,
  createdAt: new Date().toISOString(),
}

describe('postRedemptionNotify: chatAnnouncement retryState別のreportError到達可否 (#1033)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClaim.mockResolvedValue(claim)
    mockDecode.mockReturnValue({
      ...notifyData,
      chatSnapshot: undefined,
    })
    vi.spyOn(TwitchChatService.prototype, 'sendChatMessageDetailed').mockResolvedValue({
      outcome: 'retryable',
      reason: 'Twitch API 429: Your message was not sent because you are sending messages too quickly.',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pending（自動再試行予定）の場合はreportErrorを呼ばずwarnログのみ残す', async () => {
    mockRetry.mockResolvedValue('pending')

    await postRedemptionNotify(notifyData)

    expect(mockRetry).toHaveBeenCalledWith(
      claim,
      expect.stringContaining('too quickly'),
    )
    expect(mockReportError).not.toHaveBeenCalled()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[postRedemptionNotify] chat announcement retry scheduled',
      expect.objectContaining({ streamerId: 'streamer-1', outboxId: 'outbox-1' }),
    )
    expect(mockMarkSent).not.toHaveBeenCalled()
    expect(mockDeadLetter).not.toHaveBeenCalled()
  })

  it('dead（再試行を使い切った）の場合は従来通りreportErrorを呼ぶ', async () => {
    mockRetry.mockResolvedValue('dead')

    await postRedemptionNotify(notifyData)

    // レビュー指摘: expect.any(Error)だけだとretryStateの文字列連結が壊れても
    // 検知できないため、メッセージ本文と呼び出し回数まで固定する。
    expect(mockReportError).toHaveBeenCalledTimes(1)
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Chat announcement dead: '),
      }),
      expect.objectContaining({
        context: 'eventsub:postRedemptionNotify:chatAnnouncement',
        streamerId: 'streamer-1',
      }),
    )
  })

  it('lost-lease（lease競合で更新不能）の場合も従来通りreportErrorを呼ぶ', async () => {
    mockRetry.mockResolvedValue('lost-lease')

    await postRedemptionNotify(notifyData)

    expect(mockReportError).toHaveBeenCalledTimes(1)
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Chat announcement lost-lease: '),
      }),
      expect.objectContaining({
        context: 'eventsub:postRedemptionNotify:chatAnnouncement',
        streamerId: 'streamer-1',
      }),
    )
  })
})
