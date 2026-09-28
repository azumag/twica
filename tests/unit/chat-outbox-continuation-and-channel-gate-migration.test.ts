import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'db/planetscale/migrations/20260922100000_chat_outbox_continuation_and_channel_gate.sql',
  ),
  'utf8',
)

describe('chat outbox continuation and channel gate migration', () => {
  it('pending_kindをinitial/retry/continuationの3値に限定する', () => {
    expect(migration).toContain("ADD COLUMN pending_kind text NOT NULL DEFAULT 'initial'")
    expect(migration).toContain("CHECK (pending_kind IN ('initial', 'retry', 'continuation'))")
  })

  it('wake_reserved_untilはNOT NULLを付けずNULL許容のまま追加する', () => {
    expect(migration).toContain('ADD COLUMN wake_reserved_until timestamptz;')
    expect(migration).not.toContain('wake_reserved_until timestamptz NOT NULL')
  })

  it('回収sweeper用の部分indexをpendingのoutbox行だけに絞る', () => {
    expect(migration).toContain('CREATE INDEX chat_notification_outbox_wake_due_idx')
    expect(migration).toContain('ON public.chat_notification_outbox (next_attempt_at, created_at)')
    expect(migration).toContain("WHERE status = 'pending';")
  })

  it('chat_channel_send_gateテーブルはservice_roleのみに公開する', () => {
    expect(migration).toContain('CREATE TABLE public.chat_channel_send_gate (')
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.chat_channel_send_gate FROM PUBLIC, anon, authenticated;',
    )
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE ON TABLE public.chat_channel_send_gate TO service_role;',
    )
  })

  it('reserve_chat_channel_send_slot関数はservice_roleのみに公開する', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.reserve_chat_channel_send_slot(text, integer) FROM PUBLIC, anon, authenticated;',
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.reserve_chat_channel_send_slot(text, integer) TO service_role;',
    )
  })

  it('reserve_chat_channel_send_slot関数はsearch_pathを固定する', () => {
    expect(migration).toContain('CREATE FUNCTION public.reserve_chat_channel_send_slot(')
    expect(migration).toContain('SET search_path = public, pg_temp')
  })
})
