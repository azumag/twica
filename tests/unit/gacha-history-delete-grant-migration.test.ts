import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

// Issue #689: service_role の DELETE 権限を暗黙のデフォルト権限へ依存させると、
// 新規環境の再構築時に DELETE /api/gacha-history/[id] だけが壊れ得る。
// migration の実行テストはデプロイ側で担保し、ここでは権限・対象テーブル・role の
// いずれかが将来の編集で欠落する回帰を、既存migrationテストと同じ静的検証で防ぐ。
describe('gacha_history explicit DELETE grant migration', () => {
  const migration = readFileSync(
    resolve(
      __dirname,
      '../../supabase/migrations/20260712211038_explicitly_grant_gacha_history_delete.sql'
    ),
    'utf-8'
  )

  it('grants DELETE on public.gacha_history to service_role', () => {
    expect(migration).toMatch(
      /GRANT\s+DELETE\s+ON\s+TABLE\s+public\.gacha_history\s+TO\s+service_role\s*;/i
    )
  })
})
