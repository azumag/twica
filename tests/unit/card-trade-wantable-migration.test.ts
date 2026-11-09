import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Issue #1790: cards.trade_wantable と accept_trade_offer の差し替え。
// RPC の挙動そのもの（拒否・復活・冪等リプレイ）は実 PostgreSQL の
// tests/integration/trade-visibility-pg.test.ts で検証する。ここでは
// 「#1789 の4引数版から #1790 ブロック以外を変えていない」という、レビューで
// 目視に頼りがちな不変条件と、権限・宣言を文字列で固定する。

const read = (name: string) =>
  readFileSync(join(process.cwd(), 'db/planetscale/migrations', name), 'utf8')

const migration = read('20261014100000_card_trade_wantable.sql')
const previous = read('20261011120000_trade_wanted_quantity.sql')

/** `CREATE [OR REPLACE] FUNCTION ...(.., p_expected_quantity smallint) ... $$;` の本体 */
function fourArgFunctionBody(sql: string): string {
  const start = sql.search(/CREATE (OR REPLACE )?FUNCTION public\.accept_trade_offer\(\n  p_twitch_user_id text,\n  p_trade_offer_id uuid,\n  p_request_id uuid,\n  p_expected_quantity smallint/)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sql.indexOf('$$;', start)
  return sql.slice(start, end).replace(/^CREATE (OR REPLACE )?FUNCTION/, 'CREATE FUNCTION')
}

describe('card trade wantable migration (#1790)', () => {
  it('PlanetScale transaction migrationとして宣言する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
  })

  it('既定 true の NOT NULL 列として追加する（既存カードの挙動は不変）', () => {
    expect(migration).toContain(
      'ALTER TABLE public.cards\n  ADD COLUMN trade_wantable boolean NOT NULL DEFAULT true;',
    )
  })

  it('4引数版は #1789 版に #1790 ブロック（宣言1行と検証1ブロック）だけを加えたもの', () => {
    const next = fourArgFunctionBody(migration)
    const prev = fourArgFunctionBody(previous)
    const withoutAddition = next
      .replace('  v_wanted_card_wantable boolean;\n', '')
      .replace(/  -- #1790: 求めるカードが[\s\S]*?WANTED_CARD_NOT_WANTABLE'\);\n  END IF;\n\n/, '')
    expect(withoutAddition).toBe(prev)
    expect(next).not.toBe(prev)
  })

  it('冪等リプレイ判定と枚数照合の後、どの行ロックよりも前に検証し、オファーを cancelled にしない', () => {
    const body = fourArgFunctionBody(migration)
    const replay = body.indexOf("'idempotentReplay', true")
    const quantity = body.indexOf("'QUANTITY_MISMATCH'")
    const wantable = body.indexOf("'WANTED_CARD_NOT_WANTABLE'")
    const firstLock = body.indexOf('FOR UPDATE;', body.indexOf('-- 出品カード実在チェック'))
    expect(replay).toBeGreaterThan(0)
    expect(quantity).toBeGreaterThan(replay)
    expect(wantable).toBeGreaterThan(quantity)
    expect(firstLock).toBeGreaterThan(wantable)

    const block = body.slice(body.indexOf('  SELECT trade_wantable INTO v_wanted_card_wantable'), wantable)
    expect(block).toContain('IF v_wanted_card_wantable IS NOT TRUE THEN')
    expect(block).not.toContain('UPDATE')
    expect(block).not.toContain('FOR UPDATE')
  })

  it('3引数版は新しいコードを旧アプリが知る OFFER_NOT_OPEN へ読み替える', () => {
    expect(migration).toContain(
      "IF v_result->>'error' IN ('QUANTITY_MISMATCH', 'WANTED_CARD_NOT_WANTABLE') THEN",
    )
  })

  it('両シグネチャとも runtime ロールだけに公開する', () => {
    for (const signature of ['(text, uuid, uuid, smallint)', '(text, uuid, uuid)']) {
      expect(migration).toContain(
        `REVOKE ALL ON FUNCTION public.accept_trade_offer${signature} FROM PUBLIC, anon, authenticated;`,
      )
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.accept_trade_offer${signature} TO service_role;`,
      )
    }
  })

  it('適用済み: 内容を凍結する（1文字でも変えると次回 apply / verify が必ず失敗する）', () => {
    // db-migrate はファイル内容全体の SHA-256 を twica_meta.schema_migrations へ記録し、
    // 適用済み version の checksum が変わっていると status / plan / apply / verify の
    // いずれも checksum 不一致で即エラー終了する（scripts/lib/db-migrate-core.js の
    // computeChecksum / scripts/db-migrate.js の hasBlockingErrors）。
    // この migration は PR #1800 の merge 時に preview へ適用済み
    // （PlanetScale Migrations run 38446119017, 2026-10-13T18:22:34Z。
    // 履歴 checksum 0193b02a9d59… と一致する）。CI の PlanetScale migration ジョブは
    // 履歴の無い一時 DB へ適用するため checksum 不一致を検出できず、適用済みファイル
    // への編集は merge 後にしか表面化しない。PR #1869 がロック待ち上限
    //（SET LOCAL lock_timeout）をこの適用済みファイルへ追記し、実際に preview の
    // planetscale-migrate.yml を失敗させた（run 39193633861。取り消し済み）。
    // 以後の編集を merge 前に CI で止めるため、#1828 と同じ方式で checksum を固定する。
    // migration のロック待ち上限は docs/db-schema-migration-reference.md の方針に従い、
    // 「新規の」migration で設定する。
    const checksum = createHash('sha256').update(migration, 'utf8').digest('hex')
    expect(checksum).toBe('0193b02a9d596cc697ad74c9c72507158ca54fa56c4a7bb369f22d29111d7e1d')
  })
})
