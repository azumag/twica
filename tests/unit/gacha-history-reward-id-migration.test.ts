import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Issue #591: gacha_history.reward_id 列の追加と execute_gacha_transaction RPC
// のシグネチャ拡張。card-issuance-migration.test.ts (00067) / pack-rarity-weights
// -migration.test.ts (00065) と同じく、SQLテキストへの静的正規表現アサーション
// であり、実DB実行はしない。
describe('gacha_history reward_id migration (00070)', () => {
  const migration = readFileSync(
    resolve(__dirname, '../../supabase/migrations/00070_add_gacha_history_reward_id.sql'),
    'utf-8'
  )

  it('adds a nullable reward_id column to gacha_history', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS reward_id TEXT')
    // NOT NULL/CHECK 制約を付けていないこと(既存行のバックフィルが無いため必須)
    expect(migration).not.toMatch(/reward_id TEXT NOT NULL/i)
  })

  it('documents the column with COMMENT ON COLUMN', () => {
    expect(migration).toMatch(/COMMENT ON COLUMN gacha_history\.reward_id IS/i)
  })

  it('drops the old 6-arg signature before recreating (avoids overload coexistence, mirrors 00033)', () => {
    const dropIndex = migration.indexOf(
      'DROP FUNCTION IF EXISTS execute_gacha_transaction(TEXT, TEXT, TEXT, UUID, UUID, INTEGER);'
    )
    const createIndex = migration.indexOf('CREATE OR REPLACE FUNCTION execute_gacha_transaction(')

    expect(dropIndex).toBeGreaterThan(-1)
    expect(createIndex).toBeGreaterThan(dropIndex)
  })

  it('extends the RPC signature with p_reward_id as a trailing DEFAULT NULL parameter', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION execute_gacha_transaction\(\s*p_event_id TEXT,\s*p_user_twitch_id TEXT,\s*p_user_twitch_username TEXT,\s*p_card_id UUID,\s*p_streamer_id UUID,\s*p_reward_cost INTEGER DEFAULT NULL,\s*p_reward_id TEXT DEFAULT NULL\s*\) RETURNS JSONB/i
    )
  })

  it('inserts reward_id into gacha_history alongside the other columns', () => {
    expect(migration).toMatch(
      /INSERT INTO gacha_history \(event_id, user_twitch_id, user_twitch_username, card_id, streamer_id, reward_cost, reward_id\)/i
    )
    expect(migration).toMatch(
      /VALUES \(p_event_id, p_user_twitch_id, p_user_twitch_username, p_card_id, p_streamer_id, p_reward_cost, p_reward_id\)/i
    )
  })

  it('preserves the issuance-limit enforcement (FOR UPDATE lock before history/card inserts) from 00067', () => {
    const lockIndex = migration.indexOf('FOR UPDATE')
    const countIndex = migration.indexOf('SELECT COUNT(*) INTO v_issued_count')
    const historyInsertIndex = migration.indexOf('INSERT INTO gacha_history')
    const userCardInsertIndex = migration.indexOf('INSERT INTO user_cards')

    expect(lockIndex).toBeGreaterThan(-1)
    expect(countIndex).toBeGreaterThan(lockIndex)
    expect(historyInsertIndex).toBeGreaterThan(countIndex)
    expect(userCardInsertIndex).toBeGreaterThan(historyInsertIndex)
    expect(migration).toContain("'limit_reached', true")
  })

  it('keeps RPC execution limited to service_role under the new 7-arg signature', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION execute_gacha_transaction\(TEXT, TEXT, TEXT, UUID, UUID, INTEGER, TEXT\) FROM PUBLIC/i
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION execute_gacha_transaction\(TEXT, TEXT, TEXT, UUID, UUID, INTEGER, TEXT\) TO service_role/i
    )
  })

  it('documents the deploy-window compatibility analysis (both directions)', () => {
    // (a) old app code + new DB: DEFAULT param resolves safely
    expect(migration).toMatch(/DEFAULT NULL のため/)
    // (b) new app code + old DB: 42883 via PostgREST named-argument dispatch,
    // absorbed by the existing executeGachaLegacy fallback
    expect(migration).toContain('42883')
    expect(migration).toMatch(/executeGachaLegacy/)
  })

  it('does not introduce permissive public RLS policies', () => {
    expect(migration).not.toMatch(/FOR ALL\s+USING\s*\(true\)/i)
    expect(migration).not.toMatch(/TO\s+authenticated/i)
    expect(migration).not.toMatch(/TO\s+anon/i)
  })
})
