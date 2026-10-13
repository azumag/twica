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
})
