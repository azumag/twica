import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Issue #784: get_gacha_drop_stats から手動ドロー(event_id LIKE 'manual:%')を
// 除外する migration の内容を、gacha-drop-stats-index-migration.test.ts
// (20260713080000) と同じくSQLテキストへの静的正規表現アサーションで検証する
// (実DB実行はしない。Docker Postgres 17 での実行時検証は別途手動で実施)。
describe('exclude manual draws from gacha drop stats migration (20260718140000, Issue #784)', () => {
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../supabase/migrations/20260718140000_exclude_manual_draws_from_gacha_drop_stats.sql'
    ),
    'utf-8'
  )

  // ヘッダーコメントは説明のため `event_id NOT LIKE 'manual:%'` や
  // `CREATE INDEX CONCURRENTLY` を散文中で言及する(例:「使用しない」)ため、
  // 実際のSQL文だけを対象に数えるようコメント行(`--`始まり)を除外する。
  const sqlOnly = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')

  it('references Issue #784', () => {
    expect(migration).toMatch(/#784/)
  })

  it('adds the manual-draw exclusion predicate to all 4 gacha_history reference sites', () => {
    const matches = sqlOnly.match(/(gh\.)?event_id NOT LIKE 'manual:%'/g)
    expect(matches).toHaveLength(4)
  })

  it('keeps the REVOKE/GRANT permissions from earlier migrations', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION get_gacha_drop_stats(UUID, TIMESTAMPTZ, INTEGER) TO service_role;'
    )
  })

  it('rebuilds the #672 covering index with event_id added to INCLUDE so the new predicate stays index-only', () => {
    expect(migration).toContain(
      'DROP INDEX IF EXISTS idx_gacha_history_streamer_redeemed_card_user;'
    )
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_gacha_history_streamer_redeemed_card_user\s+ON gacha_history\(streamer_id, redeemed_at, card_id, user_twitch_id\)\s+INCLUDE \(user_twitch_username, event_id\)/
    )
  })

  it('is transaction-safe and idempotent (no CONCURRENTLY)', () => {
    expect(sqlOnly).not.toMatch(/CREATE INDEX CONCURRENTLY/i)
  })
})
