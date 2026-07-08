import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Issue #661: p_event_id = NULL のとき、gacha_history.event_id の UNIQUE
// 制約 + ON CONFLICT (event_id) DO NOTHING による重複検知が (NULL同士は
// UNIQUE制約上「重複」とみなされないため) 一切機能しなくなる。RPCの先頭で
// NULLを明示的に拒否するようにした migration の内容を、
// gacha-history-reward-id-migration.test.ts (00070) と同じく
// SQLテキストへの静的正規表現アサーションで検証する(実DB実行はしない)。
describe('reject null gacha event_id migration (00073)', () => {
  const migration = readFileSync(
    resolve(__dirname, '../../supabase/migrations/00073_reject_null_gacha_event_id.sql'),
    'utf-8'
  )

  it('rejects a NULL p_event_id with a RAISE EXCEPTION', () => {
    expect(migration).toMatch(/IF p_event_id IS NULL THEN\s*\n\s*RAISE EXCEPTION/i)
  })

  it('performs the NULL check before any write (INSERT) so the guard has zero side effects', () => {
    const nullCheckIndex = migration.indexOf('IF p_event_id IS NULL THEN')
    const firstInsertIndex = migration.indexOf('INSERT INTO')

    expect(nullCheckIndex).toBeGreaterThan(-1)
    expect(firstInsertIndex).toBeGreaterThan(nullCheckIndex)
  })

  it('keeps the 00070 7-arg signature unchanged (no DROP FUNCTION needed, no new params)', () => {
    // シグネチャ(引数リスト)は変更しないため、00070のようなDROP FUNCTIONは不要
    expect(migration).not.toMatch(/DROP FUNCTION/i)
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION execute_gacha_transaction\(\s*p_event_id TEXT,\s*p_user_twitch_id TEXT,\s*p_user_twitch_username TEXT,\s*p_card_id UUID,\s*p_streamer_id UUID,\s*p_reward_cost INTEGER DEFAULT NULL,\s*p_reward_id TEXT DEFAULT NULL\s*\) RETURNS JSONB/i
    )
  })

  it('preserves the existing event_id duplicate-detection and issuance-limit logic from 00070', () => {
    expect(migration).toContain('ON CONFLICT (event_id) DO NOTHING')
    expect(migration).toContain("'is_duplicate', true")
    expect(migration).toContain("'limit_reached', true")
    expect(migration).toContain('FOR UPDATE')
  })

  it('documents why the NULL check exists', () => {
    expect(migration).toMatch(/UNIQUE制約/)
    expect(migration).toMatch(/ON CONFLICT/)
  })
})
