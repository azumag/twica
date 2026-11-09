// Real-PostgreSQL contract test for gacha history tombstones
// (20261027000000_gacha_history_event_tombstones.sql).
//
// A viewer can hard-delete their own gacha_history rows. Before the tombstones,
// the deleted event_id was no longer an idempotency key: a Twitch redelivery or
// a KV replay of the same redemption re-issued cards (a 3-draw redemption ended
// with 4 cards). This suite drives GachaService.executeGachaForEventSub and the
// RPC against a database with the PlanetScale baseline + every migration
// applied, and checks that:
//   - a delete in the middle of an N-draw batch does not re-issue the deleted
//     draw, and the remaining draws and the chat outbox still complete;
//   - replaying a completed batch after a delete issues nothing;
//   - a single draw stays idempotent after its row is deleted;
//   - card deletion (CASCADE) leaves no tombstone and removes old ones.
//
// Each test uses its own event ids and viewer ids (prefix "gt1-"). The channel
// and cards are seeded once and removed in afterAll. Dedicated disposable
// PostgreSQL only; without GACHA_TOMBSTONE_TEST_DATABASE_URL the suite is skipped.
//
// Local run (example):
//   apply db/planetscale baseline + grants + migrations (see ci.yml
//   "Apply PlanetScale baseline and additive migrations"), then
//   GACHA_TOMBSTONE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres \
//     npx vitest run tests/integration/gacha-history-tombstone-pg.test.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import * as schema from '@/lib/db/schema'

const url = process.env.GACHA_TOMBSTONE_TEST_DATABASE_URL

const handle = vi.hoisted(() => ({
  current: null as null | { db: unknown; sql: unknown },
}))

vi.mock('@/lib/db/client', () => ({
  getDb: async () => {
    if (!handle.current) throw new Error('GACHA_TOMBSTONE_TEST_DATABASE_URL handle not initialised')
    return handle.current
  },
}))
vi.mock('@/lib/db/retry', () => ({
  withDbRetry: async (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn().mockResolvedValue(undefined),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

import { GachaService } from '@/lib/services/gacha'

const sql = url ? postgres(url, { max: 4, onnotice: () => {} }) : null
if (sql) handle.current = { db: drizzle(sql, { schema }), sql }

const STREAMER_ID = '9e7a0000-0000-4000-8000-000000000001'
const BROADCASTER_TWITCH_ID = 'gt1-broadcaster'
const MULTI_REWARD_ID = 'gt1-multi-reward'
const CARD_IDS = [
  '9e7a0000-0000-4000-8000-000000000101',
  '9e7a0000-0000-4000-8000-000000000102',
]
// The cascade test deletes this card; the other tests never draw it.
const CASCADE_CARD_ID = '9e7a0000-0000-4000-8000-000000000199'

function redemptionEvent(viewerId: string, rewardId: string, cost: number) {
  return {
    broadcaster_user_id: BROADCASTER_TWITCH_ID,
    user_id: viewerId,
    user_login: viewerId,
    user_name: viewerId,
    reward: { id: rewardId, cost },
  }
}

async function callRpc(params: {
  eventId: string
  viewerId: string
  cardId: string
  batchId: string | null
  drawIndex: number
  drawCount: number
}) {
  const [row] = await sql!<Array<{ result: Record<string, unknown> }>>`
    SELECT execute_gacha_transaction_with_chat_outbox(
      p_event_id => ${params.eventId},
      p_user_twitch_id => ${params.viewerId},
      p_user_twitch_username => ${params.viewerId},
      p_card_id => ${params.cardId}::uuid,
      p_streamer_id => ${STREAMER_ID}::uuid,
      p_reward_cost => ${params.drawIndex === 1 ? 300 : null}::integer,
      p_reward_id => ${MULTI_REWARD_ID},
      p_chat_batch_id => ${params.batchId},
      p_draw_index => ${params.drawIndex}::integer,
      p_draw_count => ${params.drawCount}::integer,
      p_collection_name => ${null}
    ) AS result
  `
  return row.result
}

/** Same statement shape as DELETE /api/gacha-history/[id] after its owner check. */
async function viewerDeletesHistory(eventId: string) {
  await sql!`
    DELETE FROM gacha_history
    WHERE id = (SELECT id FROM gacha_history WHERE event_id = ${eventId})
  `
}

async function ownedCardCount(viewerId: string): Promise<number> {
  const [row] = await sql!<Array<{ n: number }>>`
    SELECT count(*)::integer AS n
    FROM user_cards uc
    JOIN users u ON u.id = uc.user_id
    WHERE u.twitch_user_id = ${viewerId}
  `
  return row.n
}

async function tombstoneExists(eventId: string): Promise<boolean> {
  const rows = await sql!`
    SELECT 1 FROM gacha_history_event_tombstones WHERE event_id = ${eventId}
  `
  return rows.length > 0
}

describe.skipIf(!sql)('gacha history tombstones (PostgreSQL)', () => {
  beforeAll(async () => {
    await sql!`
      INSERT INTO streamers (
        id, twitch_user_id, twitch_username, twitch_display_name,
        channel_point_reward_id, chat_announcement_enabled
      )
      VALUES (
        ${STREAMER_ID}, ${BROADCASTER_TWITCH_ID}, 'gt1broadcaster', 'gt1broadcaster',
        'gt1-main-reward', true
      )
    `
    for (const [index, cardId] of [...CARD_IDS, CASCADE_CARD_ID].entries()) {
      await sql!`
        INSERT INTO cards (id, streamer_id, name, rarity, drop_rate, is_active)
        VALUES (${cardId}, ${STREAMER_ID}, ${`gt1 card ${index}`}, 'common', 1, ${cardId !== CASCADE_CARD_ID})
      `
    }
    await sql!`
      INSERT INTO streamer_additional_gacha_rewards (streamer_id, reward_id, draw_count)
      VALUES (${STREAMER_ID}, ${MULTI_REWARD_ID}, 3)
    `
  })

  afterAll(async () => {
    if (!sql) return
    // streamers CASCADE removes cards, gacha_history, user_cards (via cards),
    // tombstones and the additional reward. Outbox rows and users are keyed by
    // this suite's batch / viewer ids.
    await sql`DELETE FROM chat_notification_outbox WHERE batch_id LIKE 'gt1-%'`
    await sql`DELETE FROM streamers WHERE id = ${STREAMER_ID}`
    await sql`DELETE FROM users WHERE twitch_user_id LIKE 'gt1-%'`
    await sql.end()
  })

  it('N連の途中で削除されたdrawを再発行せず、残りのdrawとoutboxを完成させる', async () => {
    const viewer = 'gt1-viewer-mid'
    const batch = 'gt1-batch-mid'
    await callRpc({ eventId: batch, viewerId: viewer, cardId: CARD_IDS[0], batchId: batch, drawIndex: 1, drawCount: 3 })
    await callRpc({ eventId: `${batch}:2`, viewerId: viewer, cardId: CARD_IDS[1], batchId: batch, drawIndex: 2, drawCount: 3 })
    await viewerDeletesHistory(batch)
    expect(await tombstoneExists(batch)).toBe(true)
    expect(await ownedCardCount(viewer)).toBe(2)

    // Twitch redelivery / KV replay of the same redemption.
    const service = new GachaService()
    const replay = await service.executeGachaForEventSub({
      event: redemptionEvent(viewer, MULTI_REWARD_ID, 300),
      eventId: batch,
    })

    expect(replay.success).toBe(true)
    if (replay.success) {
      expect(replay.data.cards).toHaveLength(3)
      expect(replay.data.cards?.[0]?.id).toBe(CARD_IDS[0])
    }
    // Before the fix this was 4: the deleted first draw was issued again.
    expect(await ownedCardCount(viewer)).toBe(3)

    const [outbox] = await sql!<Array<{ assembled_draw_count: number; card_count: number }>>`
      SELECT assembled_draw_count, jsonb_array_length(payload -> 'gachaResult' -> 'cards') AS card_count
      FROM chat_notification_outbox
      WHERE batch_id = ${batch}
    `
    expect(outbox).toEqual({ assembled_draw_count: 3, card_count: 3 })

    // A second replay is a pure duplicate.
    const again = await service.executeGachaForEventSub({
      event: redemptionEvent(viewer, MULTI_REWARD_ID, 300),
      eventId: batch,
    })
    expect(again).toEqual({ success: false, error: 'Duplicate event' })
    expect(await ownedCardCount(viewer)).toBe(3)
  })

  it('完了済みbatchの履歴を削除してからreplayしても何も発行しない', async () => {
    const viewer = 'gt1-viewer-done'
    const batch = 'gt1-batch-done'
    const service = new GachaService()
    const first = await service.executeGachaForEventSub({
      event: redemptionEvent(viewer, MULTI_REWARD_ID, 300),
      eventId: batch,
    })
    expect(first.success).toBe(true)
    expect(await ownedCardCount(viewer)).toBe(3)

    // Deleting every row of the batch, including the final draw, is the
    // worst case: a retained KV entry could otherwise re-issue all N cards.
    for (const eventId of [batch, `${batch}:2`, `${batch}:3`]) {
      await viewerDeletesHistory(eventId)
    }

    const replay = await service.executeGachaForEventSub({
      event: redemptionEvent(viewer, MULTI_REWARD_ID, 300),
      eventId: batch,
    })
    expect(replay).toEqual({ success: false, error: 'Duplicate event' })
    expect(await ownedCardCount(viewer)).toBe(3)

    // The RPC itself also rejects each deleted event, and the duplicate final
    // draw still rebuilds the full batch from the tombstones.
    const finalDraw = await callRpc({
      eventId: `${batch}:3`, viewerId: viewer, cardId: CARD_IDS[0], batchId: batch, drawIndex: 3, drawCount: 3,
    })
    expect(finalDraw.is_duplicate).toBe(true)
    expect(finalDraw.cards).toHaveLength(3)
    expect(await ownedCardCount(viewer)).toBe(3)
  })

  it('単発ドローも削除後の再実行で再発行しない', async () => {
    const viewer = 'gt1-viewer-single'
    const eventId = 'gt1-single'
    const first = await callRpc({ eventId, viewerId: viewer, cardId: CARD_IDS[0], batchId: null, drawIndex: 1, drawCount: 1 })
    expect(first.is_duplicate).toBe(false)
    await viewerDeletesHistory(eventId)

    const again = await callRpc({ eventId, viewerId: viewer, cardId: CARD_IDS[1], batchId: null, drawIndex: 1, drawCount: 1 })
    expect(again.is_duplicate).toBe(true)
    expect(await ownedCardCount(viewer)).toBe(1)
  })

  it('カード削除のCASCADEでは墓石を残さず、既存の墓石も消える', async () => {
    const viewer = 'gt1-viewer-cascade'
    // The RPC only issues active cards; activate the cascade card for this test.
    await sql!`UPDATE cards SET is_active = true WHERE id = ${CASCADE_CARD_ID}`
    await callRpc({ eventId: 'gt1-cascade-kept', viewerId: viewer, cardId: CASCADE_CARD_ID, batchId: null, drawIndex: 1, drawCount: 1 })
    await callRpc({ eventId: 'gt1-cascade-deleted', viewerId: viewer, cardId: CASCADE_CARD_ID, batchId: null, drawIndex: 1, drawCount: 1 })
    await viewerDeletesHistory('gt1-cascade-deleted')
    expect(await tombstoneExists('gt1-cascade-deleted')).toBe(true)

    await sql!`DELETE FROM cards WHERE id = ${CASCADE_CARD_ID}`

    // The cascaded history delete must not create a tombstone: the issued
    // user_cards row is gone too, so a later re-run is not a double issue.
    expect(await tombstoneExists('gt1-cascade-kept')).toBe(false)
    // The FK cascade removes the tombstone that referenced the deleted card.
    expect(await tombstoneExists('gt1-cascade-deleted')).toBe(false)
    expect(await ownedCardCount(viewer)).toBe(0)
  })
})
