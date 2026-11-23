import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// トレードの「交換対象の制限」を配信者単位へ変える migration
// (20261124000000_trade_wanted_allowlist_per_streamer.sql)。
// RPC の挙動そのもの(許可・拒否・復活・冪等リプレイ)は実 PostgreSQL の
// tests/integration/trade-wanted-restriction-pg.test.ts で検証する。ここでは、
// レビューで目視に頼りがちな不変条件を文字列で固定する:
//   - 既存データを変えない(既存テーブルへの DROP / ALTER / UPDATE / DELETE が無い)
//   - 旧 migration(プレビュー適用済み)を編集せず、旧テーブルも同じ migration では削除しない
//   - 差し替える関数は、最新定義から「制限の確認ブロック」だけを配信者単位へ変えたもの
//   - 判定は「出品カードの配信者にルールあり AND 許可に無い」を1つの IF 式で書き、
//     冪等リプレイ・枚数照合の後、行ロックより前に置く
//   - 権限・宣言

const read = (name: string) =>
  readFileSync(join(process.cwd(), 'db/planetscale/migrations', name), 'utf8')

const migration = read('20261124000000_trade_wanted_allowlist_per_streamer.sql')
const previous = read('20261123000000_trade_wanted_restrictions.sql')
const auctions = read('20261018030000_trade_auctions.sql')

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

/**
 * 制限ブロック: 先頭の `  -- 出品カードの配信者が設定した「交換対象の制限」(配信者ごとの
 * 許可リスト)` コメントから、その直後の `  END IF;\n` まで。
 */
const RESTRICTION_BLOCK =
  /\n  -- 出品カードの配信者が設定した「交換対象の制限」\(配信者ごとの許可リスト\)[\s\S]*?\n  END IF;\n/

describe('trade wanted allowlist per streamer migration', () => {
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
    // 旧テーブル(20261123000000 で作成済み)は同じ migration では触らない。
    // 新 RPC も旧テーブルを参照しない(下の関数テストで固定)。削除は別 Issue の contract migration。
    expect(sql).not.toMatch(/\btrade_wanted_restriction_(rules|items)\b/)
    // INSERT / UPDATE / DELETE は関数本体(既存ロジックの再掲。差分は下で固定)の中にだけ現れる。
    const outsideFunctions = sql.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\n\$\$;/g, '')
    const kinds = outsideFunctions
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => statement.split(/\s+/).slice(0, 3).join(' '))
    const allowed = new Set([
      'SET LOCAL lock_timeout',
      'CREATE TABLE public.trade_wanted_allowlist_rules',
      'CREATE TABLE public.trade_wanted_allowlist_items',
      'CREATE INDEX idx_trade_wanted_allowlist_items_wanted',
      'COMMENT ON TABLE',
      'COMMENT ON FUNCTION',
      'REVOKE ALL ON',
      'GRANT SELECT, INSERT,',
      'GRANT EXECUTE ON',
    ])
    for (const kind of kinds) expect(allowed, `unexpected statement: ${kind}`).toContain(kind)
  })

  it('プレビュー適用済みの旧 migration は編集せず、旧テーブルを参照する定義のまま残す', () => {
    // 旧 migration は適用済みのため内容を変えてはならない(変更すると checksum 不一致で
    // db-migrate が適用済み migration の改変として検出する)。
    expect(previous).toContain('CREATE TABLE public.trade_wanted_restriction_rules (')
    expect(previous).toContain('CREATE TABLE public.trade_wanted_restriction_items (')
    expect(previous).toContain('FROM public.trade_wanted_restriction_rules')
    // 新 migration は新テーブルだけを作り、旧テーブルを DROP しない。
    expect(migration).toContain('CREATE TABLE public.trade_wanted_allowlist_rules (')
    expect(migration).toContain('CREATE TABLE public.trade_wanted_allowlist_items (')
  })

  it('親子2テーブル: 親は配信者ごとに1行で許可0件でも残り(fail-closed)、子は親・許可カードの削除に連動する', () => {
    // ルールのキーは配信者。カードの物理削除では親行が消えない(fail-closed)。
    expect(migration).toContain(
      'CREATE TABLE public.trade_wanted_allowlist_rules (\n  streamer_id uuid PRIMARY KEY REFERENCES public.streamers(id) ON DELETE CASCADE,',
    )
    expect(migration).toContain(
      'REFERENCES public.trade_wanted_allowlist_rules(streamer_id) ON DELETE CASCADE',
    )
    expect(migration).toContain(
      'wanted_card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE',
    )
    expect(migration).toContain('PRIMARY KEY (streamer_id, wanted_card_id)')
    // 旧仕様の「出品カード自身は許可できない」CHECK は廃止した(リストは出品カードに依存しない)。
    expect(migration).not.toMatch(/CHECK\s*\(/)
    // 許可カード削除時の CASCADE が全件走査にならない逆引き索引。
    expect(migration).toContain(
      'CREATE INDEX idx_trade_wanted_allowlist_items_wanted\n  ON public.trade_wanted_allowlist_items (wanted_card_id);',
    )
  })

  describe.each([
    ['accept_trade_offer(4引数)', ACCEPT4, "'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED'"],
    ['place_trade_auction_bid', PLACE, "'BID_CARD_NOT_ALLOWED_FOR_OFFERED'"],
    ['trade_auction_bid_unsettleable_reason', UNSETTLEABLE, "'BID_CARD_NOT_ALLOWED_FOR_OFFERED'"],
  ])('%s', (_name, header, errorLiteral) => {
    const next = functionBody(migration, header)
    const prev = functionBody(auctions, header)

    it('最新定義から制限ブロック(1か所)だけを配信者単位へ置き換えたもの', () => {
      expect(next.match(new RegExp(RESTRICTION_BLOCK.source, 'g'))).toHaveLength(1)
      expect(next.replace(RESTRICTION_BLOCK, '')).toBe(prev)
    })

    it('「出品カードの配信者にルールあり AND 許可に無い」を1つの IF 式で判定し、行をロックしない', () => {
      const block = next.match(RESTRICTION_BLOCK)![0]
      // 判定キーは出品カードの配信者(cards.streamer_id)で、ルールは配信者ごとに1つ。
      expect(block).toContain('JOIN public.trade_wanted_allowlist_rules AS restriction_rule')
      expect(block).toContain('restriction_rule.streamer_id = restriction_offered_card.streamer_id')
      expect(block).toContain('JOIN public.trade_wanted_allowlist_items AS restriction_item')
      expect(block).toContain('restriction_item.wanted_card_id = ')
      // 旧テーブル(出品カードごと)は参照しない。
      expect(block).not.toContain('trade_wanted_restriction_')
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

  it('3引数ラッパーは旧アプリ互換の読み替えを変えない(新しいコードは増やさない)', () => {
    // 4引数版のエラーコードは既存の WANTED_CARD_NOT_ALLOWED_FOR_OFFERED のままなので、
    // 3引数ラッパーの読み替えリストは 20261123000000 から変更しない。
    const next = functionBody(migration, ACCEPT3)
    const prev = functionBody(previous, ACCEPT3)
    expect(next).toBe(prev)
    expect(next).toContain(
      "'QUANTITY_MISMATCH', 'WANTED_CARD_NOT_WANTABLE', 'WANTED_CARD_NOT_ALLOWED_FOR_OFFERED'",
    )
  })

  it('settle_trade_auction は差し替えない(unsettleable_reason を呼ぶだけで、成立可否が一致する)', () => {
    expect(migration).not.toMatch(/FUNCTION public\.settle_trade_auction\(/)
    expect(auctions).toContain('public.trade_auction_bid_unsettleable_reason(v_bid.id)')
  })

  it('テーブル・関数とも runtime ロールだけに公開する', () => {
    for (const table of ['trade_wanted_allowlist_rules', 'trade_wanted_allowlist_items']) {
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
