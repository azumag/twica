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
  CHAT_OUTBOX_DEAD_RETENTION_DAYS,
  CHAT_OUTBOX_MAX_ATTEMPTS,
  CHAT_OUTBOX_SENT_RETENTION_DAYS,
  advanceChatNotificationDeliveryCursor,
  claimChatNotificationForBoundedDelivery,
  maintainChatNotificationOutbox,
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

  // Issue #1665 Step 3 レビュー指摘(P2): 専用Queue経路が配送ownerのあいだ、Cron relayは
  // 旧claimループへ入らない。保持期限メンテナンスをclaim時にだけ実行する構造だと、
  // ①5回目のclaim後に停止した processing 行が dead へ移行しない
  // ②sent 7日 / dead 30日 の保持期限によるpayload削除が止まる
  // という退行になる。ここでは maintenance の実SQL結果を固定する
  // （relayがowner分岐に関係なく1回呼ぶことは unit test 側で固定している）。
  describe('retention maintenance', () => {
    async function ageAs(
      batchId: string,
      status: 'sent' | 'dead',
      ageDays: number,
    ) {
      // seedRow は last_error に 'previous failure' を入れるため、保持期限の判定が
      // last_error に依存しないことを含めて null に落としておく。
      if (status === 'sent') {
        await sql!`
          update chat_notification_outbox
          set status = 'sent', last_error = null,
              sent_at = now() - (${ageDays}::integer * interval '1 day')
          where batch_id = ${batchId}
        `
        return
      }
      await sql!`
        update chat_notification_outbox
        set status = 'dead', last_error = null,
            dead_at = now() - (${ageDays}::integer * interval '1 day')
        where batch_id = ${batchId}
      `
    }

    async function retained(batchId: string): Promise<boolean> {
      const rows = await sql!<{ batch_id: string }[]>`
        select batch_id from chat_notification_outbox where batch_id = ${batchId}
      `
      return rows.length === 1
    }

    it('moves an expired max-attempt processing row to dead and spares other rows', async () => {
      // 5回目のclaim後に停止した行（lease失効 + 試行上限）。bounded claim
      // (attempt_count < 上限) からもwake予約 (同じ上限条件) からも除外されるため、
      // メンテナンスでdead化しないと永久にprocessingのまま残る。
      const exhausted = await seedRow({ status: 'processing', attempts: CHAT_OUTBOX_MAX_ATTEMPTS })
      // 上限未満でlease失効した行は回収対象であり、dead化しない。
      const recoverable = await seedRow({ status: 'processing', attempts: CHAT_OUTBOX_MAX_ATTEMPTS - 1 })
      // lease有効中で上限到達した行は旧ownerの作業中とみなし触らない。
      const activeLease = await seedRow({ status: 'processing', attempts: CHAT_OUTBOX_MAX_ATTEMPTS })
      await sql!`update chat_notification_outbox set lease_expires_at = now() + interval '1 minute'
        where batch_id = ${activeLease}`

      // 前提: 対象行は「回収もwake予約もされない processing」の形で存在している。
      expect(await stored(exhausted)).toMatchObject({ status: 'processing' })

      await maintainChatNotificationOutbox()

      expect(await stored(exhausted)).toMatchObject({
        status: 'dead', attempt_count: CHAT_OUTBOX_MAX_ATTEMPTS, lease_id: null,
        // seedRow が入れた last_error は coalesce で保持される（上書きしない）。
        last_error: 'previous failure',
      })
      const [deadRow] = await sql!<{ dead_at: Date | null; lease_expires_at: Date | null }[]>`
        select dead_at, lease_expires_at from chat_notification_outbox where batch_id = ${exhausted}
      `
      expect(deadRow.dead_at).not.toBeNull()
      expect(deadRow.lease_expires_at).toBeNull()
      expect(await stored(recoverable)).toMatchObject({ status: 'processing', attempt_count: CHAT_OUTBOX_MAX_ATTEMPTS - 1 })
      expect(await stored(activeLease)).toMatchObject({ status: 'processing' })
    })

    it('records the dead reason when the stopped row has no previous error', async () => {
      const exhausted = await seedRow({ status: 'processing', attempts: CHAT_OUTBOX_MAX_ATTEMPTS })
      await sql!`update chat_notification_outbox set last_error = null where batch_id = ${exhausted}`

      await maintainChatNotificationOutbox()

      expect(await stored(exhausted)).toMatchObject({
        status: 'dead',
        last_error: 'delivery lease expired after max attempts',
      })
    })

    it('deletes only payloads past their retention window', async () => {
      const oldSent = await seedRow()
      const freshSent = await seedRow()
      const oldDead = await seedRow()
      const freshDead = await seedRow()
      await ageAs(oldSent, 'sent', CHAT_OUTBOX_SENT_RETENTION_DAYS + 1)
      await ageAs(freshSent, 'sent', CHAT_OUTBOX_SENT_RETENTION_DAYS - 1)
      await ageAs(oldDead, 'dead', CHAT_OUTBOX_DEAD_RETENTION_DAYS + 1)
      await ageAs(freshDead, 'dead', CHAT_OUTBOX_DEAD_RETENTION_DAYS - 1)

      // 前提: 4行とも削除前は存在している（削除の有無だけを検証する）。
      expect(await retained(oldSent)).toBe(true)
      expect(await retained(oldDead)).toBe(true)

      await maintainChatNotificationOutbox()

      expect(await retained(oldSent)).toBe(false)
      expect(await retained(oldDead)).toBe(false)
      expect(await retained(freshSent)).toBe(true)
      expect(await retained(freshDead)).toBe(true)
    })

    it('is idempotent: a second run changes nothing', async () => {
      const exhausted = await seedRow({ status: 'processing', attempts: CHAT_OUTBOX_MAX_ATTEMPTS })
      const oldSent = await seedRow()
      await ageAs(oldSent, 'sent', CHAT_OUTBOX_SENT_RETENTION_DAYS + 1)

      await maintainChatNotificationOutbox()
      const afterFirst = await stored(exhausted)
      await maintainChatNotificationOutbox()

      expect(await stored(exhausted)).toEqual(afterFirst)
      expect(await retained(oldSent)).toBe(false)
    })
  })
})
