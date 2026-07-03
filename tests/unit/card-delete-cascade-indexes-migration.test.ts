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
  // battles 向けの1文は pg_class 存在チェック(DO $$ ... EXECUTE '...' $$)で
  // 囲まれ EXECUTE 文字列の中に埋め込まれているため、行頭一致ではなく
  // 非コメント行を連結したテキストに対する正規表現マッチで抽出する
  // (トップレベルの文・EXECUTE 文字列内の文の両方を同じ形で拾える)。
  // 説明コメント中で「CONCURRENTLY」「CREATE INDEX IF NOT EXISTS」という
  // 語句そのものに触れているため、コメント行は事前に除外する。
  const nonCommentText = migration
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
  const statementLines = [
    ...nonCommentText.matchAll(/CREATE INDEX IF NOT EXISTS \w+\s*\n?\s*ON \w+\([^)]+\)/g),
  ].map((m) => m[0].replace(/\s+/g, ' '))

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

  it('guards only the battles index behind a pg_class existence check (production lacks the battles table per 00024 precedent)', () => {
    // battles/battle_stats は 00024_fix_rls_policies_security.sql の時点で
    // 既に本番に存在しないことが判明していたテーブル(battle機能はナビゲーション
    // からリンクされていない未使用機能で、テーブルがマイグレーション経路外で
    // 欠落している)。無条件の CREATE INDEX ON battles(...) は本番で
    // "relation battles does not exist" (42P01) で失敗し、単一トランザクション
    // のため他3インデックスも巻き添えでロールバックする
    // (これが実際にこのmigrationを本番で失敗させた障害そのもの)。
    expect(migration).toMatch(
      /IF EXISTS \(SELECT 1 FROM pg_class WHERE relname = 'battles'\)[\s\S]*?EXECUTE 'CREATE INDEX IF NOT EXISTS idx_battles_opponent_card_id ON battles\(opponent_card_id\)'/
    )
    // gacha_history / card_owner_stats / card_stone_transactions は実在が
    // 確定しているテーブルなので無条件のままであるべき(過剰な防御は避ける)。
    // ガードが1箇所(battles)にしか存在しないことで、それを確認する
    // (説明コメント中の「pg_class」という語自体への言及は除外するため、
    // コメント除去済みの nonCommentText を数える)。
    const pgClassGuardCount = (nonCommentText.match(/pg_class/g) || []).length
    expect(pgClassGuardCount).toBe(1)
  })

  it('does not introduce permissive public RLS policies', () => {
    expect(migration).not.toMatch(/FOR ALL\s+USING\s*\(true\)/i)
    expect(migration).not.toMatch(/TO\s+authenticated/i)
    expect(migration).not.toMatch(/TO\s+anon/i)
  })
})
