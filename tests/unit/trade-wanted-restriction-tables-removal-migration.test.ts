import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APPROVED_CONTRACT_MIGRATIONS } from '../../scripts/db-migrate.js'
import { detectNonAdditiveStatements } from '../../scripts/lib/db-migrate-core.js'

// Issue #2118: 旧「交換対象の制限」2テーブル
// (trade_wanted_restriction_rules / trade_wanted_restriction_items)を削除する
// contract migration (20261125000000_drop_trade_wanted_restriction_tables.sql)。
//
// 実行時の安全性は migration 内のガード(SQL)で担保する。ここでは、レビューで目視に
// 頼りがちな不変条件を文字列で固定する:
//   - 非加法的な DROP TABLE として検知され、承認一覧・例外リストに登録されている
//   - ガード(関数の非参照・0件)が DROP より前にあり、崩れたら DROP しない
//   - 子 → 親の順で、対象の2テーブルだけを DROP する
//   - アプリ側(schema.ts)に旧定義が残っていない

const FILENAME = '20261125000000_drop_trade_wanted_restriction_tables.sql'
const VERSION = '20261125000000'

const read = (name: string) =>
  readFileSync(join(process.cwd(), 'db/planetscale/migrations', name), 'utf8')

const migration = read(FILENAME)

const CHILD_DROP = 'DROP TABLE IF EXISTS public.trade_wanted_restriction_items;'
const PARENT_DROP = 'DROP TABLE IF EXISTS public.trade_wanted_restriction_rules;'

/** 実行コード(行コメント・ブロックコメントを除去) */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

describe('trade wanted restriction tables removal migration (Issue #2118)', () => {
  it('PlanetScale transaction migration として宣言し、最初の文で lock_timeout を設定する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/)
    const statements = code(migration)
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  it('旧テーブルを参照する関数・0件でないデータがあれば DROP せず中止する', () => {
    const firstDrop = migration.indexOf(CHILD_DROP)
    const guard = migration.slice(0, firstDrop)

    // 判定関数が旧テーブルを参照したまま DROP すると、本番の応諾・入札が実行時に壊れる。
    expect(guard).toContain('pg_get_functiondef(p.oid)')
    // 集約・ウィンドウ関数の行で pg_get_functiondef が 42809 にならないよう、CASE で
    // 通常関数・プロシージャの行だけに適用する(WHERE の条件との評価順は保証されない)。
    expect(guard).toContain(
      "CASE WHEN p.prokind IN ('f', 'p') THEN pg_get_functiondef(p.oid) ELSE '' END",
    )
    expect(guard).toContain("strpos(")
    expect(guard).toContain("'trade_wanted_restriction_'")
    expect(guard).toContain("n.nspname = 'public'")
    // 行が残っていれば黙って消さずに中止する(テーブルが無い環境では飛ばす)。
    expect(guard).toContain("to_regclass('public.trade_wanted_restriction_rules') IS NOT NULL")
    expect(guard).toContain("to_regclass('public.trade_wanted_restriction_items') IS NOT NULL")
    expect(guard).toContain('SELECT count(*) INTO v_rows FROM public.trade_wanted_restriction_rules;')
    expect(guard).toContain('SELECT count(*) INTO v_rows FROM public.trade_wanted_restriction_items;')
    // 関数1 + テーブル2 の3か所すべてで RAISE EXCEPTION する。
    expect(guard.match(/RAISE EXCEPTION/g)).toHaveLength(3)
  })

  it('行数を数える前に両テーブルを ACCESS EXCLUSIVE でロックする(数えた後の書き込みを防ぐ)', () => {
    const rulesLock = migration.indexOf(
      'LOCK TABLE public.trade_wanted_restriction_rules IN ACCESS EXCLUSIVE MODE;',
    )
    const rulesCount = migration.indexOf(
      'SELECT count(*) INTO v_rows FROM public.trade_wanted_restriction_rules;',
    )
    const itemsLock = migration.indexOf(
      'LOCK TABLE public.trade_wanted_restriction_items IN ACCESS EXCLUSIVE MODE;',
    )
    const itemsCount = migration.indexOf(
      'SELECT count(*) INTO v_rows FROM public.trade_wanted_restriction_items;',
    )
    // 親 → 子の順にロックして数える(子が親を参照する FK の書き込み順に合わせ、
    // 逆順のデッドロックを避ける)。数えた後、DROP までロックを保持する。
    expect(rulesLock).toBeGreaterThanOrEqual(0)
    expect(rulesCount).toBeGreaterThan(rulesLock)
    expect(itemsLock).toBeGreaterThan(rulesCount)
    expect(itemsCount).toBeGreaterThan(itemsLock)
    expect(itemsCount).toBeLessThan(migration.indexOf(CHILD_DROP))
  })

  it('子 → 親の順で、IF EXISTS 付きで DROP する', () => {
    expect(migration).toContain(CHILD_DROP)
    expect(migration).toContain(PARENT_DROP)
    expect(migration.indexOf(CHILD_DROP)).toBeLessThan(migration.indexOf(PARENT_DROP))
  })

  it('削除するのは旧2テーブルだけで、新テーブルや他のオブジェクトには触れない', () => {
    const sql = code(migration)
    const drops = [...sql.matchAll(/DROP\s+(?:TABLE|VIEW|FUNCTION|COLUMN|INDEX|CONSTRAINT|TRIGGER)\b[^;]*;/gi)].map(
      (match) => match[0].trim(),
    )
    expect(drops).toEqual([CHILD_DROP, PARENT_DROP])
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i)
    expect(sql).not.toMatch(/\bTRUNCATE\b/i)
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i)
    // 置き換え先(#2117)のテーブルは触らない。
    expect(sql).not.toMatch(/trade_wanted_allowlist_(rules|items)/)
  })

  it('非加法的な DROP TABLE として検知される(承認一覧・例外リストが必要なこと)', () => {
    const findings = detectNonAdditiveStatements(migration)
    expect(findings.map((finding) => finding.kind)).toEqual([
      'DROP TABLE/VIEW/FUNCTION',
      'DROP TABLE/VIEW/FUNCTION',
    ])
    // 検知行は実際の DROP 文だけを指す(コメントや RAISE メッセージ中の語では発火しない)。
    const lines = migration.split('\n')
    expect(findings.map((finding) => lines[finding.line - 1].trim())).toEqual([
      CHILD_DROP,
      PARENT_DROP,
    ])
  })

  it('APPROVED_CONTRACT_MIGRATIONS に version・checksum・根拠が登録されている', () => {
    // 登録が無い/checksum が違うと push の自動適用は DROP をブロックする
    // (tests/unit/db-migrate-cli.test.ts が全 entry と実ファイルの一致を検証する)。
    const approval = APPROVED_CONTRACT_MIGRATIONS.get(VERSION)
    expect(approval).toBeDefined()
    expect(approval?.checksum).toBe(
      createHash('sha256').update(migration, 'utf8').digest('hex'),
    )
    expect(approval?.reason).toContain('#2118')
  })

  it('アプリ側の旧 Drizzle 定義が残っていない(verify-db-schema の双方向突き合わせと整合)', () => {
    const schema = readFileSync(join(process.cwd(), 'src/lib/db/schema.ts'), 'utf8')
    expect(schema).not.toMatch(/trade_wanted_restriction|tradeWantedRestriction/)
  })
})
