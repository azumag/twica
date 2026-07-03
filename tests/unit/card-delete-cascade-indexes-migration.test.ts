import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Issue #614: DELETE /api/cards/[id] が本番で Postgres の statement timeout
// (57014) を起こした障害の恒久対策。cards.id を参照する5本のFKのうち
// user_cards.card_id 以外の4本(gacha_history.card_id / battles.opponent_card_id /
// card_owner_stats.card_id / card_stone_transactions.card_id)が無索引だったため
// カスケードDELETE/SET NULLが子テーブル全件スキャンになっていたことが根本原因。
// pack-rarity-weights-migration.test.ts (00065) / gacha-history-reward-id
// -migration.test.ts (00070) と同じく、SQLテキストへの静的正規表現アサーション
// であり、実DB実行はしない。
describe('card delete cascade indexes migration (00071, Issue #614)', () => {
  const migration = readFileSync(
    resolve(__dirname, '../../supabase/migrations/00071_add_card_delete_cascade_indexes.sql'),
    'utf-8'
  )

  // 実際の CREATE INDEX 文だけを抽出する(先頭が `--` のコメント行は除外)。
  // 説明コメント中で「CONCURRENTLY」「CREATE INDEX IF NOT EXISTS」という
  // 語句そのものに触れているため、行頭アンカー無しの単純な文字列一致だと
  // コメントを誤検出する。以降の全アサーションはこのフィルタ済み配列を使う。
  const statementLines = migration
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('CREATE INDEX'))

  it('references Issue #614', () => {
    expect(migration).toMatch(/#614/)
  })

  it('adds an index on gacha_history.card_id (ON DELETE CASCADE, 00001)', () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_gacha_history_card_id\s*\n?\s*ON gacha_history\(card_id\)/
    )
  })

  it('adds an index on battles.opponent_card_id (ON DELETE CASCADE, 00002)', () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_battles_opponent_card_id\s*\n?\s*ON battles\(opponent_card_id\)/
    )
  })

  it('adds an index on card_owner_stats.card_id (ON DELETE CASCADE, 00051)', () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_card_owner_stats_card_id\s*\n?\s*ON card_owner_stats\(card_id\)/
    )
  })

  it('adds an index on card_stone_transactions.card_id (ON DELETE SET NULL, 00059)', () => {
    expect(migration).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_card_stone_transactions_card_id\s*\n?\s*ON card_stone_transactions\(card_id\)/
    )
  })

  it('creates exactly these 4 indexes (no more, no fewer)', () => {
    const names = statementLines.map((line) => line.match(/idx_\w+/)?.[0]).sort()
    expect(names).toEqual(
      [
        'idx_battles_opponent_card_id',
        'idx_card_owner_stats_card_id',
        'idx_card_stone_transactions_card_id',
        'idx_gacha_history_card_id',
      ].sort()
    )
  })

  it('follows the idx_<table>_<column> naming convention used by idx_user_cards_card_id (00001)', () => {
    expect(statementLines.some((line) => line.includes('idx_gacha_history_card_id'))).toBe(true)
    expect(statementLines.some((line) => line.includes('idx_battles_opponent_card_id'))).toBe(true)
    expect(statementLines.some((line) => line.includes('idx_card_owner_stats_card_id'))).toBe(true)
    expect(statementLines.some((line) => line.includes('idx_card_stone_transactions_card_id'))).toBe(true)
  })

  it('uses plain CREATE INDEX (not CONCURRENTLY), matching the 00032 precedent for transaction-wrapped migrations', () => {
    // supabase db push applies migrations inside a transaction block, and
    // CREATE INDEX CONCURRENTLY cannot run inside one (00032 established this
    // precedent). Every statement here must be a plain, transaction-safe
    // CREATE INDEX IF NOT EXISTS.
    expect(statementLines.length).toBeGreaterThan(0)
    for (const statement of statementLines) {
      expect(statement).not.toMatch(/CONCURRENTLY/i)
    }
  })

  it('is idempotent (IF NOT EXISTS) so re-running the migration is safe', () => {
    expect(statementLines.length).toBe(4)
    for (const statement of statementLines) {
      expect(statement).toContain('IF NOT EXISTS')
    }
  })

  it('does not introduce permissive public RLS policies', () => {
    expect(migration).not.toMatch(/FOR ALL\s+USING\s*\(true\)/i)
    expect(migration).not.toMatch(/TO\s+authenticated/i)
    expect(migration).not.toMatch(/TO\s+anon/i)
  })
})
