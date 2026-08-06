import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { detectNonAdditiveStatements } from '../../scripts/lib/db-migrate-core.js'

/**
 * Issue #800: リポジトリ実ファイル全体への非加法的migrationスキャン（回帰テスト）。
 *
 * 目的:
 * 新規に追加されたmigrationが非加法的な文（DROP COLUMN / RENAME / ALTER COLUMN TYPE /
 * DROP TABLE等 / TRUNCATE）を含んでいないかを、PR時点で機械的に検知する。
 * `planetscale-migrate.yml` の自動適用は additive な変更のみ許可する運用のため、
 * ここで検知されれば CI（apply）でも同じガードにブロックされる。
 *
 * 既知の適用済み例外:
 * 下記6ファイルは本ガード導入前に本番へ適用済みの「関数シグネチャ変更」
 * （`DROP FUNCTION IF EXISTS <旧シグネチャ>` → `CREATE OR REPLACE FUNCTION`）を含む。
 * ガードは未適用(pending)migrationのみを対象とするため、これらはブロック対象外であり、
 * このテストでは例外リストとして明示する。将来、意図的に非加法的なmigrationを追加する
 * 場合は、contractフェーズとして手動適用すること（このリストに理由を添えて追加する
 * と、レビューで意図が伝わる）。
 */
const KNOWN_APPLIED_NON_ADDITIVE = new Set([
  '00033_add_reward_cost_to_gacha_history.sql',
  '00052_add_drawers_to_gacha_drop_stats.sql',
  '00060_card_stone_exchange_idempotency.sql',
  '00067_add_card_issuance_limits.sql',
  '00069_add_issued_card_counts_rpc.sql',
  '00070_add_gacha_history_reward_id.sql',
])

const MIGRATION_DIRS = [
  join(__dirname, '..', '..', 'supabase', 'migrations'),
  join(__dirname, '..', '..', 'db', 'planetscale', 'migrations'),
]

describe('全migrationファイルの非加法的文スキャン (Issue #800)', () => {
  it('既知の適用済み例外以外に非加法的な文を含むmigrationが存在しない', () => {
    const unexpected: string[] = []
    for (const dir of MIGRATION_DIRS) {
      for (const filename of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
        const content = readFileSync(join(dir, filename), 'utf8')
        const findings = detectNonAdditiveStatements(content)
        if (findings.length > 0 && !KNOWN_APPLIED_NON_ADDITIVE.has(filename)) {
          unexpected.push(
            `${filename}: ${findings.map((f) => `${f.kind}(行${f.line})`).join(', ')}`
          )
        }
      }
    }
    expect(unexpected, unexpected.join('\n')).toEqual([])
  })

  it('既知の適用済み例外ファイルは検知対象に実際にマッチしている（リストの陳腐化防止）', () => {
    let matched = 0
    for (const dir of MIGRATION_DIRS) {
      for (const filename of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
        if (!KNOWN_APPLIED_NON_ADDITIVE.has(filename)) continue
        const content = readFileSync(join(dir, filename), 'utf8')
        if (detectNonAdditiveStatements(content).length > 0) matched++
      }
    }
    // ファイルが削除・改名されたり、内容からDROP系が消えたりしたら例外リストが
    // 陳腐化して「例外扱い」が無意味になるため、実マッチ件数とリスト件数を突き合わせる
    expect(matched).toBe(KNOWN_APPLIED_NON_ADDITIVE.size)
  })
})
