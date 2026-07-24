import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@/lib/db/client'
import {
  CHAT_OUTBOX_MAX_ATTEMPTS,
  claimChatNotificationBatch,
  claimDueChatNotifications,
  decodeChatNotificationPayload,
  deadLetterChatNotification,
  markChatNotificationSent,
  peekChatNotificationOutboxWork,
  renewChatNotificationLease,
  retryChatNotification,
} from '@/lib/services/chat-notification-outbox'

function createSqlMock(responses: unknown[][]) {
  let index = 0
  return vi.fn(() => {
    const rows = responses[Math.min(index, responses.length - 1)] ?? []
    index += 1
    return Promise.resolve(rows)
  })
}

function renderSqlCall(sqlMock: ReturnType<typeof vi.fn>, index: number) {
  const [strings, ...values] = sqlMock.mock.calls[index] as [readonly string[], ...unknown[]]
  return { text: strings.join('$'), values }
}

const CLAIM_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  batch_id: 'batch-1',
  payload_version: 1,
  payload: { batchId: 'batch-1' },
  lease_id: '22222222-2222-4222-8222-222222222222',
  attempt_count: 1,
  created_at: '2026-07-25T00:00:00.000Z',
}

describe('transactional chat outbox claim/ack', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('期限到来順をFOR UPDATE SKIP LOCKEDでclaimし、同時relayの重複取得を避ける', async () => {
    const sqlMock = createSqlMock([[], [], [CLAIM_ROW]])
    vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sqlMock as never })

    const claims = await claimDueChatNotifications(20)

    expect(claims).toEqual([{
      id: CLAIM_ROW.id,
      batchId: 'batch-1',
      payloadVersion: 1,
      payload: { batchId: 'batch-1' },
      leaseId: CLAIM_ROW.lease_id,
      attemptCount: 1,
      createdAt: CLAIM_ROW.created_at,
    }])
    const expire = renderSqlCall(sqlMock, 0)
    expect(expire.text).toContain("status = 'dead'")
    expect(expire.text).toContain('lease_expires_at <= now()')
    expect(expire.values).toContain(CHAT_OUTBOX_MAX_ATTEMPTS)

    const cleanup = renderSqlCall(sqlMock, 1)
    expect(cleanup.text).toContain('delete from chat_notification_outbox')
    expect(cleanup.text).toContain("status = 'sent'")
    expect(cleanup.text).toContain("status = 'dead'")

    const claim = renderSqlCall(sqlMock, 2)
    expect(claim.text).toContain('for update skip locked')
    expect(claim.text).toContain("status = 'pending'")
    expect(claim.text).toContain("status = 'processing'")
    expect(claim.text).toContain('attempt_count < $::integer')
    expect(claim.values).toContain(1)
  })

  it('ライブ配送はbatch_idで1件だけclaimする', async () => {
    const sqlMock = createSqlMock([[CLAIM_ROW]])
    vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sqlMock as never })

    const claim = await claimChatNotificationBatch('batch-1')

    expect(claim?.batchId).toBe('batch-1')
    const rendered = renderSqlCall(sqlMock, 0)
    expect(rendered.text).toContain('where batch_id = $')
    expect(rendered.values).toContain('batch-1')
  })

  it('dry-run peekはDB-only pendingと保持期限メンテナンス候補をread-onlyで検出する', async () => {
    const sqlMock = createSqlMock([[
      { id: CLAIM_ROW.id, batch_id: CLAIM_ROW.batch_id, created_at: CLAIM_ROW.created_at },
    ]])
    vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sqlMock as never })

    await expect(peekChatNotificationOutboxWork(20)).resolves.toEqual([{
      id: CLAIM_ROW.id,
      batchId: CLAIM_ROW.batch_id,
      createdAt: CLAIM_ROW.created_at,
    }])

    const rendered = renderSqlCall(sqlMock, 0)
    expect(rendered.text).toContain("status = 'pending'")
    expect(rendered.text).toContain("status = 'sent'")
    expect(rendered.text).toContain("status = 'dead'")
    expect(rendered.text).toContain('select id, batch_id, created_at')
  })

  it('payload v1をbatch一致時だけdecodeし、未知versionとbatch不一致を拒否する', () => {
    const payload = {
      batchId: 'batch-1',
      broadcasterTwitchUserId: 'broadcaster-1',
      userId: 'viewer-1',
      streamer: {
        id: 'streamer-1',
        chat_announcement_enabled: true,
        chat_announcement_template: null,
        chat_announcement_multi_template: null,
        chat_announcement_multi_show_cards: true,
        default_card_pack_name: null,
      },
      gachaResult: {
        type: 'gacha',
        userTwitchUsername: 'Viewer',
        rewardId: 'reward-1',
        collectionName: null,
        card: {
          id: 'card-1', name: 'Alpha', description: null, image_url: null,
          rarity: 'rare', drop_rate: 1,
        },
        cards: [{
          id: 'card-1', name: 'Alpha', description: null, image_url: null,
          rarity: 'rare', drop_rate: 1,
        }],
      },
      chatSnapshot: {
        cardCount: 1,
        uniqueCount: 1,
        allCount: 10,
        newCardNames: ['Alpha'],
      },
    }

    expect(decodeChatNotificationPayload({
      batchId: 'batch-1',
      payloadVersion: 1,
      payload,
    })).toEqual(payload)
    expect(decodeChatNotificationPayload({
      batchId: 'batch-1',
      payloadVersion: 2,
      payload,
    })).toBeNull()
    expect(decodeChatNotificationPayload({
      batchId: 'different-batch',
      payloadVersion: 1,
      payload,
    })).toBeNull()
    expect(decodeChatNotificationPayload({
      batchId: 'batch-1',
      payloadVersion: 1,
      payload: { ...payload, chatSnapshot: undefined },
    })).toBeNull()
  })

  it('sent更新はidとlease_idの両方でfenceする', async () => {
    const sqlMock = createSqlMock([[{ id: CLAIM_ROW.id }]])
    vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sqlMock as never })

    await expect(markChatNotificationSent({
      id: CLAIM_ROW.id,
      leaseId: CLAIM_ROW.lease_id,
    })).resolves.toBe(true)

    const rendered = renderSqlCall(sqlMock, 0)
    expect(rendered.text).toContain("status = 'sent'")
    expect(rendered.text).toContain('where id = $::uuid')
    expect(rendered.text).toContain('lease_id = $::uuid')
    expect(rendered.values).toEqual([CLAIM_ROW.id, CLAIM_ROW.lease_id])
  })

  it('外部送信直前のlease更新もidとlease_idでfenceする', async () => {
    const sqlMock = createSqlMock([[{ id: CLAIM_ROW.id }]])
    vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sqlMock as never })

    await expect(renewChatNotificationLease({
      id: CLAIM_ROW.id,
      leaseId: CLAIM_ROW.lease_id,
    })).resolves.toBe(true)

    const rendered = renderSqlCall(sqlMock, 0)
    expect(rendered.text).toContain('lease_expires_at = now()')
    expect(rendered.text).toContain("status = 'processing'")
    expect(rendered.text).toContain('where id = $::uuid')
    expect(rendered.text).toContain('lease_id = $::uuid')
    expect(rendered.values).toEqual([60, CLAIM_ROW.id, CLAIM_ROW.lease_id])
  })

  it('一時失敗はbackoff付きpendingへ戻し、最大試行でDLQ化する', async () => {
    const retrySql = createSqlMock([[{ id: CLAIM_ROW.id }]])
    vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: retrySql as never })

    await expect(retryChatNotification({
      id: CLAIM_ROW.id,
      leaseId: CLAIM_ROW.lease_id,
      attemptCount: 1,
    }, 'Twitch API 503')).resolves.toBe('pending')

    const retry = renderSqlCall(retrySql, 0)
    expect(retry.text).toContain("status = 'pending'")
    expect(retry.text).toContain('next_attempt_at = now()')
    expect(retry.values).toContain(60_000)

    const deadSql = createSqlMock([[{ id: CLAIM_ROW.id }]])
    vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: deadSql as never })
    await expect(retryChatNotification({
      id: CLAIM_ROW.id,
      leaseId: CLAIM_ROW.lease_id,
      attemptCount: CHAT_OUTBOX_MAX_ATTEMPTS,
    }, 'still unavailable')).resolves.toBe('dead')
    expect(renderSqlCall(deadSql, 0).text).toContain("status = 'dead'")
  })

  it('恒久失敗は即DLQ化してclaim leaseを解放する', async () => {
    const sqlMock = createSqlMock([[{ id: CLAIM_ROW.id }]])
    vi.mocked(getDb).mockResolvedValue({ db: {} as never, sql: sqlMock as never })

    await expect(deadLetterChatNotification({
      id: CLAIM_ROW.id,
      leaseId: CLAIM_ROW.lease_id,
    }, 'scope missing')).resolves.toBe(true)

    const rendered = renderSqlCall(sqlMock, 0)
    expect(rendered.text).toContain("status = 'dead'")
    expect(rendered.text).toContain('lease_id = null')
    expect(rendered.values).toEqual(['scope missing', CLAIM_ROW.id, CLAIM_ROW.lease_id])
  })
})
