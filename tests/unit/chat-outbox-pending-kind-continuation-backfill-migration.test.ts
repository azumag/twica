import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'db/planetscale/migrations/20261017010000_chat_outbox_pending_kind_continuation_backfill.sql',
  ),
  'utf8',
)

describe('chat outbox pending_kind continuation backfill migration (Issue #1665 Step 4)', () => {
  it('PlanetScale transaction migrationとして宣言する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
  })

  it('回帰: 部分配信済み行の pending_kind を continuation に補正する UPDATE を持つ', () => {
    expect(migration).toContain("SET pending_kind = 'continuation'")
    expect(migration).toContain('UPDATE public.chat_notification_outbox')
  })

  it('cursor を untouched に保持する（reset しない）— delivery_cursor の SET/UPDATE を含まない', () => {
    // migration は pending_kind のみを補正。 cursor を 0 に戻してはならない。
    const codeOnly = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    expect(codeOnly).not.toContain('delivery_cursor = 0')
    expect(codeOnly).not.toContain('delivery_cursor =')
  })

  it('部分進捗行だけに限定する: delivery_cursor > 0 AND delivery_cursor < expected_draw_count', () => {
    expect(migration).toContain('delivery_cursor > 0')
    expect(migration).toContain('delivery_cursor < expected_draw_count')
  })

  it('pending および lease 失効済み processing 行だけが対象（lease 有効中の processing は触らない）', () => {
    expect(migration).toContain("status = 'pending'")
    expect(migration).toContain("status = 'processing' AND lease_expires_at <= now()")
  })

  it('冪等: pending_kind = initial の行だけが対象', () => {
    expect(migration).toContain("pending_kind = 'initial'")
  })

  it('上限付き: LIMIT を用いた bounded 実行', () => {
    // この migration は preview で適用済みになった時点で内容が凍結された。上のテストは
    // 「適用された版がどうだったか」の記録であり、上限の存在自体は残件を生み得る。
    // 残件の補正は 20261018010000_chat_outbox_pending_kind_continuation_backfill_completion.sql
    // が担当する（そちらの契約テストは completion-migration.test.ts）。
    expect(migration).toMatch(/LIMIT\s+200/)
  })

  it('適用済み: 内容を凍結する（1文字でも変えると次回 apply / verify が必ず失敗する）', () => {
    // db-migrate はファイル内容全体の SHA-256 を twica_meta.schema_migrations へ記録し、
    // 適用済み version の checksum が変わっていると checksumMismatches として即エラー終了する
    // （scripts/lib/db-migrate-core.js の computeChecksum / scripts/db-migrate.js の
    // hasBlockingErrors）。この migration は preview へ
    // [applied] 20261017010000 chat_outbox_pending_kind_continuation_backfill として登録済み
    // （PlanetScale Migrations run 38955902112, 2026-10-16T19:35:09Z）なので、コメントの
    // 1文字変更でも migration pipeline が壊れる。CI は履歴の無い一時DBへ適用するため
    // checksum 不一致を検出できない。ここで凍結した checksum を固定する。
    const checksum = createHash('sha256').update(migration, 'utf8').digest('hex')
    expect(checksum).toBe('8b780f8659b9ab61c6b0eed4b334ea49f267727deb667b0374bbcd3a5b48133d')
  })

  it('非加法的 dangerously mutation を含まない (UPDATE のみ)', () => {
    const codeOnly = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    expect(codeOnly).not.toMatch(/\bdrop\s+column\b/i)
    expect(codeOnly).not.toMatch(/\btruncate\b/i)
  })
})
