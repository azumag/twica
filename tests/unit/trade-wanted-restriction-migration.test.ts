import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// トレードの「交換対象の制限」(20261123000000_trade_wanted_restrictions.sql)。
// RPC の挙動そのもの(許可・拒否・復活・冪等リプレイ)は実 PostgreSQL の
// tests/integration/trade-wanted-restriction-pg.test.ts で検証する。ここでは、
// レビューで目視に頼りがちな不変条件を文字列で固定する:
//   - 既存データを変えない(既存テーブルへの DROP / ALTER / UPDATE / DELETE が無い)
//   - 差し替える4関数は、最新定義から「制限の確認ブロック」だけを足したもの
//   - 判定は「ルールあり AND 許可に無い」を1つの IF 式で書き、冪等リプレイ・枚数照合の後、
//     行ロックより前に置く
//   - 権限・宣言

const read = (name: string) =>
  readFileSync(join(process.cwd(), 'db/planetscale/migrations', name), 'utf8')

const migration = read('20261123000000_trade_wanted_restrictions.sql')
const auctions = read('20261018030000_trade_auctions.sql')
const wantable = read('20261014100000_card_trade_wantable.sql')

/** 実行コード(行コメント・ブロックコメントを除去) */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

/** `CREATE [OR REPLACE] FUNCTION <header> ... \n$$;` の本体(CREATE は OR REPLACE に正規化) */
function functionBody(sql: string, header: RegExp): string {
  const start = sql.search(header)
  expect(start, `function not found: ${header}`).toBeGreaterThanOrEqual(0)
  const end = sql.indexOf('\n$$;', start) + '\n$$;'.length
  return sql.slice(start, end).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION')
}

const ACCEPT4 = /CREATE (OR REPLACE )?FUNCTION public\.accept_trade_offer\(\n  p_twitch_user_id text,\n  p_trade_offer_id uuid,\n  p_request_id uuid,\n  p_expected_quantity smallint/
const ACCEPT3 = /CREATE (OR REPLACE )?FUNCTION public\.accept_trade_offer\(\n  p_twitch_user_id text,\n  p_trade_offer_id uuid,\n  p_request_id uuid\n\)/
const PLACE = /CREATE (OR REPLACE )?FUNCTION public\.place_trade_auction_bid\(/
const UNSETTLEABLE = /CREATE (OR REPLACE )?FUNCTION public\.trade_auction_bid_unsettleable_reason\(/

/** 制限ブロック: 先頭の `  -- 制限...` コメントから、その直後の `  END IF;\n` まで */
const RESTRICTION_BLOCK = /\n  -- 出品カードの配信者が設定した「交換対象の制限」[\s\S]*?\n  END IF;\n/

describe('trade wanted restriction migration', () => {
  it('PlanetScale transaction migrationとして宣言し、最初の文で lock_timeout を設定する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/)
    const statements = code(migration).split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  it('既存データを変えない: 実行コードは新2テーブルの作成・索引・COMMENT・GRANT と関数の CREATE OR REPLACE だけ', () => {
    const sql = code(migration)
    // 既存テーブルを壊す・書き換える文が無い。
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION|INDEX|CONSTRAINT|TRIGGER)\b/i)
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i)
    expect(sql).not.toMatch(/\bTRUNCATE\b/i)
    // INSERT / UPDATE / DELETE は関数本体(既存ロジックの再掲。差分は下で固定)の中にだけ現れる。
    // 関数外の文(データを直接書き換える文)には無い。
    const outsideFunctions = sql.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/g, '')
    // 関数外の文(データを直接書き換える INSERT / UPDATE / DELETE を含む)は、下の許可リストに
    // ある種類だけ。許可リストに無い文があれば失敗する。
    const kinds = outsideFunctions
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => statement.split(/\s+/).slice(0, 3).join(' '))
    const allowed = new Set([
      'SET LOCAL lock_timeout',
      'CREATE TABLE public.trade_wanted_restriction_rules',
      'CREATE TABLE public.trade_wanted_restriction_items',
      'CREATE INDEX idx_trade_wanted_restriction_items_wanted',
      'COMMENT ON TABLE',
      'COMMENT ON FUNCTION',
      'REVOKE ALL ON',
      'GRANT SELECT, INSERT,',
      'GRANT EXECUTE ON',
    ])
    for (const kind of kinds) expect(allowed, `unexpected statement: ${kind}`).toContain(kind)
  })

  it('親子2テーブル: 親は許可0件でも残り(fail-closed)、子は親・許可カードの削除に連動し、自己指定を禁じる', () => {
    expect(migration).toContain(
      'CREATE TABLE public.trade_wanted_restriction_rules (\n  offered_card_id uuid PRIMARY KEY REFERENCES public.cards(id) ON DELETE CASCADE,',
    )
    expect(migration).toContain(
      'REFERENCES public.trade_wanted_restriction_rules(offered_card_id) ON DELETE CASCADE',
    )
    expect(migration).toContain('wanted_card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE')
    expect(migration).toContain('PRIMARY KEY (offered_card_id, wanted_card_id)')
    expect(migration).toContain('CHECK (offered_card_id <> wanted_card_id)')
    // 許可カード削除時の CASCADE が全件走査にならない逆引き索引。
    expect(migration).toContain(
      'CREATE INDEX idx_trade_wanted_restriction_items_wanted\n  ON public.trade_wanted_restriction_items (wanted_card_id);',
    )
  })

  describe.each([
    ['accept_trade_offer(4引数)', ACCEPT4, auctions, "'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED'"],
    ['place_trade_auction_bid', PLACE, auctions, "'BID_CARD_NOT_ALLOWED_FOR_OFFERED'"],
    ['trade_auction_bid_unsettleable_reason', UNSETTLEABLE, auctions, "'BID_CARD_NOT_ALLOWED_FOR_OFFERED'"],
  ])('%s', (_name, header, previousSource, errorLiteral) => {
    const next = functionBody(migration, header)
    const prev = functionBody(previousSource, header)

    it('最新定義から制限ブロック(1か所)だけを足したもの', () => {
      expect(next.match(new RegExp(RESTRICTION_BLOCK.source, 'g'))).toHaveLength(1)
      expect(next.replace(RESTRICTION_BLOCK, '')).toBe(prev)
    })

    it('「ルールあり AND 許可に無い」を1つの IF 式で判定し、ルール行・許可行をロックしない', () => {
      const block = next.match(RESTRICTION_BLOCK)![0]
      expect(block).toContain('IF EXISTS (SELECT 1 FROM public.trade_wanted_restriction_rules')
      expect(block).toContain('AND NOT EXISTS (SELECT 1 FROM public.trade_wanted_restriction_items')
      expect(block).toContain(errorLiteral)
      expect(code(block)).not.toMatch(/FOR\s+(UPDATE|SHARE)/i)
      expect(code(block)).not.toMatch(/\bUPDATE\b/i)
    })
  })

  it('応諾: 冪等リプレイ判定と枚数照合の後、どの行ロックよりも前に検証し、オファーを cancelled にしない', () => {
    const body = functionBody(migration, ACCEPT4)
    const replay = body.indexOf("'idempotentReplay', true")
    const quantity = body.indexOf("'QUANTITY_MISMATCH'")
    const wantableCheck = body.indexOf("'WANTED_CARD_NOT_WANTABLE'")
    const restriction = body.indexOf("'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED'")
    const firstLock = body.indexOf('FOR UPDATE;', body.indexOf('-- 出品カード実在チェック'))
    expect(replay).toBeGreaterThan(0)
    expect(quantity).toBeGreaterThan(replay)
    expect(wantableCheck).toBeGreaterThan(quantity)
    expect(restriction).toBeGreaterThan(wantableCheck)
    expect(firstLock).toBeGreaterThan(restriction)
    const block = body.match(RESTRICTION_BLOCK)![0]
    expect(code(block)).not.toContain("'cancelled'")
  })

  it('入札: 冪等リプレイ判定より後、入札コピーのロックより前に検証する', () => {
    const body = functionBody(migration, PLACE)
    const replay = body.indexOf("'idempotentReplay', true")
    const wantableCheck = body.indexOf("'BID_CARD_NOT_WANTABLE'")
    const restriction = body.indexOf("'BID_CARD_NOT_ALLOWED_FOR_OFFERED'")
    const copyLock = body.indexOf('FOR UPDATE', restriction)
    expect(replay).toBeGreaterThan(0)
    expect(restriction).toBeGreaterThan(wantableCheck)
    expect(copyLock).toBeGreaterThan(restriction)
  })

  it('3引数ラッパーは 20261014100000 版の読み替えに新しいコードを加えるだけ', () => {
    const next = functionBody(migration, ACCEPT3)
    const prev = functionBody(wantable, ACCEPT3)
    expect(next).toContain(
      "'QUANTITY_MISMATCH', 'WANTED_CARD_NOT_WANTABLE', 'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED'",
    )
    const normalize = (sql: string) =>
      sql
        .replace(/IF v_result->>'error' IN \([\s\S]*?\) THEN/, 'IF <codes> THEN')
    expect(normalize(next)).toBe(normalize(prev))
  })

  it('settle_trade_auction は差し替えない(unsettleable_reason を呼ぶだけで、成立可否が一致する)', () => {
    expect(migration).not.toMatch(/FUNCTION public\.settle_trade_auction\(/)
    expect(auctions).toContain('public.trade_auction_bid_unsettleable_reason(v_bid.id)')
  })

  it('テーブル・関数とも runtime ロールだけに公開する', () => {
    for (const table of ['trade_wanted_restriction_rules', 'trade_wanted_restriction_items']) {
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`)
      expect(migration).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO service_role;`,
      )
    }
    for (const signature of [
      'accept_trade_offer(text, uuid, uuid, smallint)',
      'accept_trade_offer(text, uuid, uuid)',
      'place_trade_auction_bid(text, uuid, uuid, smallint, uuid)',
      'trade_auction_bid_unsettleable_reason(uuid)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`)
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`)
    }
  })
})
