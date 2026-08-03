import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'db/planetscale/migrations/20260803090000_chat_snapshot_new_card_resolution.sql'),
  'utf8',
)

describe('chat snapshot new-card resolution migration', () => {
  // v1 JSONのdecoder互換と実際のpayload値は、それぞれdecoder unitとPostgreSQL fixtureで
  // 検証する。このファイルはSQL実装断片だけを固定し、コメント文言への依存を避ける。
  it('既適用のv1 outbox schemaを変えず、同じRPCを置換する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.execute_gacha_transaction_with_chat_outbox(')
    expect(migration).not.toContain('CREATE TABLE public.chat_notification_outbox')
    expect(migration).not.toContain('ALTER TABLE public.chat_notification_outbox')
    expect(migration).toContain('payload_version, payload, expected_draw_count')
    expect(migration).toContain('\n      1,\n      jsonb_build_object(')
  })

  it('最終所持数とevent時刻ごとの付与数が両方確認できたときだけ解決済みを加算する', () => {
    expect(migration).toContain('v_new_card_names_resolved boolean')
    expect(migration).toContain('FROM drawn_card_counts drawn\n        LEFT JOIN user_card_counts owned ON owned.card_id = drawn.card_id')
    expect(migration).toContain('WHERE owned.card_id IS NULL OR owned.final_count < drawn.drawn_count')
    expect(migration).toContain('expected_history_timestamp_counts AS')
    expect(migration).toContain('obtained_card_timestamp_counts AS')
    expect(migration).toContain('GROUP BY gh.card_id, gh.redeemed_at')
    expect(migration).toContain('GROUP BY uc.card_id, uc.obtained_at')
    expect(migration).toContain('AND confirmed.obtained_at = expected.redeemed_at')
    expect(migration).toContain('WHERE expected.redeemed_at IS NULL')
    expect(migration).toContain('OR confirmed.obtained_count < expected.expected_count')
    expect(migration).toContain("'newCardNames', v_new_card_names")
    expect(migration).toContain("'newCardNamesResolved', v_new_card_names_resolved")
  })
})
