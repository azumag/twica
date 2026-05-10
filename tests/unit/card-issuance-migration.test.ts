import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('card issuance limit migration', () => {
  const migration = readFileSync(
    resolve(__dirname, '../../supabase/migrations/00041_add_card_issuance_limits.sql'),
    'utf-8'
  )

  it('adds nullable positive issuance limit to cards', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS max_issuance_count INTEGER')
    expect(migration).toContain('CHECK (max_issuance_count IS NULL OR max_issuance_count > 0)')
  })

  it('enforces the limit in the gacha RPC before inserting history or cards', () => {
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

  it('keeps RPC execution limited to service_role', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION execute_gacha_transaction\(TEXT, TEXT, TEXT, UUID, UUID, INTEGER\) FROM PUBLIC/i)
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION execute_gacha_transaction\(TEXT, TEXT, TEXT, UUID, UUID, INTEGER\) TO service_role/i)
  })
})
