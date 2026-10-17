// Run only against a dedicated disposable PostgreSQL instance:
// CHAT_OUTBOX_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//   npx vitest run tests/integration/chat-outbox-attempt-accounting-pg.test.ts
// The real application SQL operates on a connection-local temporary table. One
// connection keeps that table visible to every claim/release/renew/retry query;
// closing it removes the fixture without changing any persisted schema or rows.
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbHandle } from '@/lib/db/client'

const handle = vi.hoisted(() => ({ current: null as DbHandle | null }))
vi.mock('@/lib/db/client', () => ({
  getDb: vi.fn(async () => {
    if (!handle.current) throw new Error('CHAT_OUTBOX_TEST_DATABASE_URL handle not initialised')
    return handle.current
  }),
}))
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/services/chat-channel-gate', () => ({ reserveChatChannelSendSlot: vi.fn() }))
vi.mock('@/lib/services/eventsub-redemption-delivery', () => ({ sendClaimedChatAnnouncement: vi.fn() }))

import { getDb } from '@/lib/db/client'
import { reserveChatChannelSendSlot } from '@/lib/services/chat-channel-gate'
import { deliverChatNotificationSlice } from '@/lib/services/chat-notification-delivery'
import {
  CHAT_OUTBOX_MAX_ATTEMPTS,
  advanceChatNotificationDeliveryCursor,
  claimChatNotificationForBoundedDelivery,
  releaseChatNotificationForContinuation,
} from '@/lib/services/chat-notification-outbox'
import { sendClaimedChatAnnouncement } from '@/lib/services/eventsub-redemption-delivery'

const url = process.env.CHAT_OUTBOX_TEST_DATABASE_URL
const sql = url ? postgres(url, { max: 1, onnotice: () => {} }) : null
if (sql) handle.current = { db: {} as never, sql }
const mockGetDb = vi.mocked(getDb)
const mockGate = vi.mocked(reserveChatChannelSendSlot)
const mockSend = vi.mocked(sendClaimedChatAnnouncement)
// This marker represents an external request in the sender double. No Twitch
// credentials, HTTP requests, or real message delivery are used by this suite.
const externalSend = vi.fn().mockResolvedValue(undefined)

interface StoredRow {
  status: string
  pending_kind: string
  attempt_count: number
  delivery_cursor: number
  lease_id: string | null
  last_error: string | null
}

async function seedRow({
  kind = 'initial', attempts = 0, status = 'pending', cursor = 0, drawCount = 1,
}: {
  kind?: 'initial' | 'retry' | 'continuation'
  attempts?: number
  status?: 'pending' | 'processing'
  cursor?: number
  drawCount?: number
} = {}) {
  const id = crypto.randomUUID()
  const batchId = `attempt-accounting-${id}`
  const card = {
    id: 'card-1', name: 'Test card', rarity: 'common', drop_rate: 1,
    description: null, image_url: null,
  }
  const payload = {
    batchId, broadcasterTwitchUserId: 'test-broadcaster', userId: 'test-viewer',
    streamer: {
      id: 'test-streamer', chat_announcement_enabled: true,
      chat_announcement_multi_show_cards: true,
    },
    gachaResult: {
      type: 'gacha', card, cards: Array.from({ length: drawCount }, () => card),
      userTwitchUsername: 'TestViewer',
    },
    chatSnapshot: { cardCount: drawCount, uniqueCount: 1, allCount: 1, newCardNames: [] },
  }
  await sql!`
    insert into chat_notification_outbox
      (id, batch_id, payload, pending_kind, attempt_count, status, delivery_cursor,
       delivery_mode, lease_id, lease_expires_at, last_error)
    values (${id}::uuid, ${batchId}, ${sql!.json(payload)}, ${kind}, ${attempts}, ${status}, ${cursor},
      ${drawCount > 1 ? 'individual' : 'summary'},
      ${status === 'processing' ? crypto.randomUUID() : null}::uuid,
      case when ${status} = 'processing' then now() - interval '1 second' else null end,
      'previous failure')
  `
  return batchId
}

async function stored(batchId: string): Promise<StoredRow> {
  const [row] = await sql!<StoredRow[]>`
    select status, pending_kind, attempt_count, delivery_cursor, lease_id, last_error
    from chat_notification_outbox where batch_id = ${batchId}
  `
  return row
}

async function makeDue(batchId: string) {
  // Use the database clock: the application budget clock is independently
  // controlled to simulate a slow DB boundary without sleeping in the test.
  await sql!`update chat_notification_outbox set next_attempt_at = now() - interval '1 second'
    where batch_id = ${batchId}`
}

function exhaustBudgetDuringClaim() {
  let clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  mockGetDb.mockImplementationOnce(async () => {
    clock += 1_000
    return handle.current!
  })
}

describe.skipIf(!sql)('chat outbox attempt accounting against PostgreSQL', () => {
  beforeAll(async () => {
    await sql!`
      create temporary table chat_notification_outbox (
        id uuid primary key,
        batch_id text not null unique,
        payload_version integer not null default 1,
        payload jsonb not null,
        status text not null default 'pending',
        pending_kind text not null default 'initial'
          check (pending_kind in ('initial', 'retry', 'continuation')),
        attempt_count integer not null default 0 check (attempt_count >= 0),
        next_attempt_at timestamptz not null default now(),
        lease_id uuid,
        lease_expires_at timestamptz,
        wake_reserved_until timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        sent_at timestamptz,
        dead_at timestamptz,
        last_error text,
        delivery_mode text not null default 'summary',
        delivery_chunk_size integer not null default 3,
        delivery_cursor integer not null default 0
      )
    `
  })
  beforeEach(async () => {
    vi.clearAllMocks()
    mockGetDb.mockReset().mockResolvedValue(handle.current!)
    mockSend.mockReset()
    mockGate.mockReset().mockResolvedValue({ outcome: 'reserved' })
    await sql!`truncate table pg_temp.chat_notification_outbox`
  })
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => { await sql?.end() })

  it.each([
    { kind: 'initial' as const, attempts: 0 },
    { kind: 'retry' as const, attempts: CHAT_OUTBOX_MAX_ATTEMPTS - 1 },
  ])('refunds a send-free slow $kind claim and counts its next real failure', async ({ kind, attempts }) => {
    const batchId = await seedRow({ kind, attempts, cursor: 2 })
    exhaustBudgetDuringClaim()

    await expect(deliverChatNotificationSlice(batchId, { timeBudgetMs: 1_000 }))
      .resolves.toMatchObject({ kind: 'deferred' })
    expect(mockSend).not.toHaveBeenCalled()
    expect(externalSend).not.toHaveBeenCalled()
    expect(await stored(batchId)).toMatchObject({
      status: 'pending', pending_kind: 'retry', attempt_count: attempts,
      delivery_cursor: 2, lease_id: null, last_error: 'previous failure',
    })

    await makeDue(batchId)
    mockSend.mockImplementation(async (_claim, _data, fence) => {
      expect(await fence()).toBe(true)
      await externalSend()
      return { outcome: 'retryable', reason: 'Twitch API 503: temporary outage' }
    })
    const result = await deliverChatNotificationSlice(batchId)
    expect(result.kind).toBe(attempts + 1 === CHAT_OUTBOX_MAX_ATTEMPTS ? 'terminal' : 'retryable')
    expect(await stored(batchId)).toMatchObject({
      status: attempts + 1 === CHAT_OUTBOX_MAX_ATTEMPTS ? 'dead' : 'pending',
      attempt_count: attempts + 1, delivery_cursor: 2, lease_id: null,
      last_error: 'Twitch API 503: temporary outage',
    })
    expect(externalSend).toHaveBeenCalledTimes(1)
  })

  it.each(['gate', 'reservation', 'renewal'] as const)(
    'refunds a send-free yield when the %s consumes the remaining budget',
    async (boundary) => {
      const batchId = await seedRow({ kind: 'retry', attempts: 2 })
      let clock = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => clock)
      if (boundary === 'gate') {
        mockGate.mockResolvedValue({ outcome: 'budget-exhausted' })
      } else if (boundary === 'reservation') {
        mockGate.mockImplementation(async () => {
          clock += 2_000
          return { outcome: 'reserved' }
        })
      } else {
        mockGetDb.mockResolvedValueOnce(handle.current!).mockImplementationOnce(async () => {
          clock += 2_000
          return handle.current!
        })
      }
      mockSend.mockImplementation(async (_claim, _data, fence, budget) => {
        if (!budget?.channelGate || budget.deadlineAt === undefined) throw new Error('Missing delivery budget')
        const gate = await budget.channelGate(budget.deadlineAt)
        if (gate.outcome === 'budget-exhausted') return { outcome: 'deferred', reason: 'budget' }
        const allowed = await fence()
        if (allowed === true) {
          await externalSend()
          return { outcome: 'sent' }
        }
        expect(allowed).toBe('budget-exhausted')
        return { outcome: 'deferred', reason: 'budget' }
      })

      await expect(deliverChatNotificationSlice(batchId, { timeBudgetMs: 5_000 }))
        .resolves.toMatchObject({ kind: 'deferred' })
      expect(mockGate).toHaveBeenCalledTimes(1)
      expect(mockGetDb).toHaveBeenCalledTimes(boundary === 'renewal' ? 3 : 2)
      expect(externalSend).not.toHaveBeenCalled()
      expect(await stored(batchId)).toMatchObject({
        status: 'pending', pending_kind: 'retry', attempt_count: 2,
        delivery_cursor: 0, lease_id: null, last_error: 'previous failure',
      })
    },
  )

  it('never decrements an existing continuation, including one at the attempt limit', async () => {
    const batchId = await seedRow({ kind: 'continuation', attempts: CHAT_OUTBOX_MAX_ATTEMPTS, cursor: 3 })
    exhaustBudgetDuringClaim()

    await expect(deliverChatNotificationSlice(batchId, { timeBudgetMs: 1_000 }))
      .resolves.toMatchObject({ kind: 'deferred' })
    expect(mockSend).not.toHaveBeenCalled()
    expect(await stored(batchId)).toMatchObject({
      status: 'pending', pending_kind: 'continuation', attempt_count: CHAT_OUTBOX_MAX_ATTEMPTS,
      delivery_cursor: 3, lease_id: null,
    })
    await makeDue(batchId)
    await expect(claimChatNotificationForBoundedDelivery(batchId)).resolves.toMatchObject({
      attemptCount: CHAT_OUTBOX_MAX_ATTEMPTS, claimAttemptIncrement: 0, deliveryCursor: 3,
    })
  })

  it('refunds only this claim when recovering expired processing from a continuation', async () => {
    const batchId = await seedRow({ kind: 'continuation', attempts: 2, status: 'processing', cursor: 3 })
    const claim = await claimChatNotificationForBoundedDelivery(batchId)
    expect(claim).toMatchObject({ attemptCount: 3, claimAttemptIncrement: 1, deliveryCursor: 3 })

    await expect(releaseChatNotificationForContinuation(claim!, new Date(), { beforeSend: true }))
      .resolves.toBe(true)
    expect(await stored(batchId)).toMatchObject({
      status: 'pending', pending_kind: 'retry', attempt_count: 2,
      delivery_cursor: 3, lease_id: null, last_error: 'previous failure',
    })
  })

  it('fences stale owners and duplicate refunds without changing the new owner counter or cursor', async () => {
    const batchId = await seedRow({ kind: 'retry', attempts: 1, cursor: 2 })
    const oldClaim = await claimChatNotificationForBoundedDelivery(batchId)
    await sql!`update chat_notification_outbox set lease_expires_at = now() - interval '1 second'
      where batch_id = ${batchId}`
    const newClaim = await claimChatNotificationForBoundedDelivery(batchId)
    expect(newClaim).toMatchObject({ attemptCount: 3, claimAttemptIncrement: 1 })
    expect(newClaim!.leaseId).not.toBe(oldClaim!.leaseId)
    const newOwnerState = await stored(batchId)

    await expect(releaseChatNotificationForContinuation(oldClaim!, new Date(), { beforeSend: true }))
      .resolves.toBe(false)
    expect(await stored(batchId)).toEqual(newOwnerState)
    await expect(releaseChatNotificationForContinuation(newClaim!, new Date(), { beforeSend: true }))
      .resolves.toBe(true)
    const releasedState = await stored(batchId)
    expect(releasedState).toMatchObject({ attempt_count: 2, delivery_cursor: 2, pending_kind: 'retry' })
    await expect(releaseChatNotificationForContinuation(newClaim!, new Date(), { beforeSend: true }))
      .resolves.toBe(false)
    expect(await stored(batchId)).toEqual(releasedState)
  })

  it.each(['failure', 'partial continuation'] as const)(
    'retains the increment after an external attempt ends in %s', async (outcome) => {
      const batchId = await seedRow({ kind: 'retry', attempts: 2, cursor: 1, drawCount: 3 })
      mockSend.mockImplementation(async (claim, _data, fence) => {
        expect(await fence()).toBe(true)
        await externalSend()
        if (outcome === 'failure') return { outcome: 'retryable', reason: 'Twitch API 503: temporary outage' }
        expect(await advanceChatNotificationDeliveryCursor(claim, 2)).toBe(true)
        return { outcome: 'deferred', reason: 'budget' }
      })

      await expect(deliverChatNotificationSlice(batchId)).resolves.toMatchObject({
        kind: outcome === 'failure' ? 'retryable' : 'deferred',
      })
      expect(externalSend).toHaveBeenCalledTimes(1)
      expect(await stored(batchId)).toMatchObject({
        status: 'pending', pending_kind: outcome === 'failure' ? 'retry' : 'continuation',
        attempt_count: 3, delivery_cursor: outcome === 'failure' ? 1 : 2, lease_id: null,
      })
    },
  )
})
