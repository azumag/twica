import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'db/planetscale/migrations/20260725100000_transactional_chat_outbox.sql'),
  'utf8',
)

describe('transactional chat outbox migration', () => {
  it('PlanetScale transaction migrationとして宣言し、versioned RPCで旧7引数を曖昧化しない', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
    expect(migration).toContain('CREATE FUNCTION public.execute_gacha_transaction_with_chat_outbox(')
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.execute_gacha_transaction(')
    expect(migration).not.toMatch(/p_chat_batch_id text DEFAULT/i)
  })

  it('カード付与とoutbox組立を同じRPC transactionに閉じ込める', () => {
    const historyInsert = migration.indexOf('INSERT INTO gacha_history')
    const cardInsert = migration.indexOf('INSERT INTO user_cards')
    const outboxInsert = migration.indexOf('INSERT INTO public.chat_notification_outbox')
    const successReturn = migration.lastIndexOf("RETURN jsonb_build_object(")

    expect(historyInsert).toBeGreaterThan(0)
    expect(cardInsert).toBeGreaterThan(historyInsert)
    expect(outboxInsert).toBeGreaterThan(cardInsert)
    expect(successReturn).toBeGreaterThan(outboxInsert)
    expect(migration).toContain('AND s.chat_announcement_enabled = true')
  })

  it('最終drawで全履歴をevent_id順に再構成し、完成済みpendingだけを作る', () => {
    const outboxInsert = migration.indexOf('INSERT INTO public.chat_notification_outbox')
    const duplicateBranch = migration.indexOf('IF v_is_duplicate THEN', outboxInsert)
    const duplicateReturn = migration.indexOf('RETURN jsonb_build_object(', duplicateBranch)

    expect(migration).toContain('p_draw_index = p_draw_count')
    expect(migration).toContain('FROM generate_series(1, p_draw_count)')
    expect(migration).toContain('jsonb_agg(card_payload ORDER BY draw_index)')
    expect(migration).toContain("RAISE EXCEPTION 'chat outbox history incomplete")
    // 最終イベントが既存でも、途中の歯抜けが別リクエストで埋まった後なら
    // outbox を復元してから duplicate を返す必要がある。
    expect(migration).toContain('v_is_duplicate := FOUND')
    expect(migration).toContain('ON CONFLICT (batch_id) DO NOTHING')
    expect(migration).toContain("'cards', CASE")
    expect(migration).toContain('THEN v_cards_payload')
    // cardsを同時に返すためjsonb_build_objectは複数行に分かれる。単一行の
    // 文字列一致ではなく、outbox復元後のduplicate分岐とそのRETURNの順序を固定する。
    expect(duplicateBranch).toBeGreaterThan(outboxInsert)
    expect(duplicateReturn).toBeGreaterThan(duplicateBranch)
    expect(migration).toContain("'pending'")
    expect(migration).not.toContain("'building'")
  })

  it('所有数系placeholderをガチャtransactionのversioned payloadへsnapshotする', () => {
    for (const fragment of [
      "'chatSnapshot', jsonb_build_object(",
      "'cardCount', v_card_count",
      "'uniqueCount', v_unique_count",
      "'allCount', v_all_count",
      "'newCardNames', v_new_card_names",
      'WITH user_card_counts AS (',
    ]) {
      expect(migration).toContain(fragment)
    }
  })

  it('NULLをPostgreSQL三値論理ですり抜けさせずdraw位置をfail-closedにする', () => {
    expect(migration).toContain('p_draw_index IS NULL OR p_draw_count IS NULL')
    expect(migration.indexOf('p_draw_index IS NULL OR p_draw_count IS NULL'))
      .toBeLessThan(migration.indexOf('p_draw_index < 1'))
  })

  it('同じeventのlive/Cron並行実行をcard選択に依存せずtransaction単位で直列化する', () => {
    const eventLock = migration.indexOf(
      'pg_advisory_xact_lock(hashtextextended(p_event_id, 803))',
    )
    const duplicateRead = migration.indexOf('SELECT id INTO v_history_id')
    const cardLock = migration.indexOf('FOR UPDATE')

    expect(eventLock).toBeGreaterThan(0)
    expect(eventLock).toBeLessThan(duplicateRead)
    expect(eventLock).toBeLessThan(cardLock)
  })

  it('claim/DLQに必要な状態・lease・attempt・due indexを持つ', () => {
    for (const fragment of [
      'payload_version smallint NOT NULL DEFAULT 1 CHECK (payload_version = 1)',
      "CHECK (status IN ('pending', 'processing', 'sent', 'dead'))",
      'attempt_count integer NOT NULL DEFAULT 0',
      'next_attempt_at timestamptz NOT NULL DEFAULT now()',
      'lease_id uuid',
      'lease_expires_at timestamptz',
      'chat_notification_outbox_due_idx',
      'chat_notification_outbox_sent_cleanup_idx',
      'chat_notification_outbox_dead_cleanup_idx',
    ]) {
      expect(migration).toContain(fragment)
    }
    expect(migration).toContain('assembled_draw_count = expected_draw_count')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated')
  })
})
