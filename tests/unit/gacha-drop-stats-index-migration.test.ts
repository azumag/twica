import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('gacha drop stats covering index migration (20260713080000, Issue #672)', () => {
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../supabase/migrations/20260713080000_add_gacha_drop_stats_covering_index.sql'
    ),
    'utf-8'
  )

  it('references Issue #672', () => {
    expect(migration).toMatch(/#672/)
  })

  it('adds the covering index used by get_gacha_drop_stats period scans', () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_gacha_history_streamer_redeemed_card_user\s+ON gacha_history\(streamer_id, redeemed_at, card_id, user_twitch_id\)\s+INCLUDE \(user_twitch_username\)/
    )
  })

  it('keeps streamer_id and redeemed_at as the leading filter columns', () => {
    expect(migration).toContain(
      'gacha_history(streamer_id, redeemed_at, card_id, user_twitch_id)'
    )
  })

  it('is transaction-safe and idempotent', () => {
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS')
    expect(migration).not.toMatch(/CREATE INDEX CONCURRENTLY/i)
  })

  it('does not change RLS or grants', () => {
    expect(migration).not.toMatch(/CREATE POLICY/i)
    expect(migration).not.toMatch(/GRANT\s+/i)
    expect(migration).not.toMatch(/REVOKE\s+/i)
  })
})
