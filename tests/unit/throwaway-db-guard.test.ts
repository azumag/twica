import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessThrowawayDatabase } from '../../scripts/lib/throwaway-db-guard.js'

// 素の CREATE DATABASE 直後の在庫（非 system schema のオブジェクトなし）。
const emptyInventory = { schemas: [], relations: [], routines: [] }

describe('throwaway database guard (Issue #1665 Step 4 fixture)', () => {
  it('素のDB（非systemオブジェクトなし）は許可する', () => {
    expect(assessThrowawayDatabase(emptyInventory)).toEqual({ ok: true, reasons: [] })
  })

  it('回帰: public.users だけがある既存DBを拒否する（bootstrap が認可関数を置換しうる）', () => {
    // bootstrap は CREATE OR REPLACE FUNCTION auth.* を独立 transaction で commit するため、
    // 後続 DDL が衝突で失敗しても置換は rollback されない。既存オブジェクトがあれば必ず拒否する。
    const result = assessThrowawayDatabase({ ...emptyInventory, relations: ['public.users'] })
    expect(result.ok).toBe(false)
    expect(result.reasons.join('\n')).toContain('public.users')
  })

  it('回帰: auth 関数だけがある既存DBを拒否する', () => {
    const result = assessThrowawayDatabase({
      ...emptyInventory,
      schemas: ['auth'],
      routines: ['auth.uid', 'auth.jwt', 'auth.role'],
    })
    expect(result.ok).toBe(false)
    expect(result.reasons.join('\n')).toContain('auth')
  })

  it('回帰: twica の outbox / migration 履歴がある既存DBを拒否する', () => {
    const result = assessThrowawayDatabase({
      schemas: ['twica_meta'],
      relations: ['public.chat_notification_outbox', 'twica_meta.schema_migrations'],
      routines: [],
    })
    expect(result.ok).toBe(false)
    expect(result.reasons.join('\n')).toContain('twica_meta')
  })

  it('pg_temp / pg_toast_temp は無視する', () => {
    const result = assessThrowawayDatabase({
      schemas: ['pg_temp_3', 'pg_toast_temp_3'],
      relations: [],
      routines: [],
    })
    expect(result.ok).toBe(true)
  })

  it('fail-closed: 在庫が取れていない / 壊れている場合は拒否する', () => {
    expect(assessThrowawayDatabase(undefined).ok).toBe(false)
    expect(assessThrowawayDatabase(null).ok).toBe(false)
    expect(assessThrowawayDatabase({ schemas: [], relations: [] }).ok).toBe(false)
    expect(assessThrowawayDatabase({ schemas: 'auth', relations: [], routines: [] }).ok).toBe(false)
  })

  it('fixture は migration の退避と最初の DDL より前にガードを実行する', () => {
    const fixture = readFileSync(
      resolve(
        process.cwd(),
        'tests/fixtures/chat-outbox-pending-kind-continuation-backfill-pg17.sh',
      ),
      'utf8',
    )
    const guardIndex = fixture.indexOf('assessThrowawayDatabase')
    const stashIndex = fixture.indexOf('STASH_DIR=$(mktemp -d)')
    const firstDdlIndex = fixture.indexOf('20260719180000_planetscale_bootstrap.sql')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(stashIndex).toBeGreaterThan(-1)
    expect(firstDdlIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(stashIndex)
    expect(guardIndex).toBeLessThan(firstDdlIndex)
  })
})
