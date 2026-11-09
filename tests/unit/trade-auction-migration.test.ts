import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Issue #1791: オークション形式の出品(20261018030000_trade_auctions.sql)。
// RPC・トリガー・拘束判定の挙動は実 PostgreSQL の
// tests/integration/trade-auction-pg.test.ts と
// tests/fixtures/trade-auction-concurrency.sh で検証する。ここでは、レビューで
// 目視に頼りがちな不変条件を文字列で固定する:
//   - accept_trade_offer(4引数版)は 20261014100000 版から、拘束判定の2か所と
//     そのコメントだけを変えたもの(返却 JSON・エラーコード・ロック順・冪等リプレイは不変)
//   - 3引数ラッパーは置き換えない(新しいエラーコードが増えないため)
//   - 宣言・lock_timeout・権限

const read = (name: string) =>
  readFileSync(join(process.cwd(), 'db/planetscale/migrations', name), 'utf8')

const migration = read('20261018030000_trade_auctions.sql')
const previous = read('20261014100000_card_trade_wantable.sql')

/** `CREATE [OR REPLACE] FUNCTION ...(.., p_expected_quantity smallint) ... $$;` の本体 */
function fourArgFunctionBody(sql: string): string {
  const start = sql.search(/CREATE (OR REPLACE )?FUNCTION public\.accept_trade_offer\(\n  p_twitch_user_id text,\n  p_trade_offer_id uuid,\n  p_request_id uuid,\n  p_expected_quantity smallint/)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = sql.indexOf('$$;', start)
  return sql.slice(start, end)
}

/** 実行コード(行コメント・ブロックコメントを除去) */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}

describe('trade auction migration (#1791)', () => {
  it('PlanetScale transaction migrationとして宣言する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/)
  })

  it('最初の文で SET LOCAL lock_timeout を設定する(トランザクション内だけに効く)', () => {
    const statements = code(migration).split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  it('accept_trade_offer(4引数版)は 20261014100000 版から拘束判定の2か所とコメントだけを変える', () => {
    const next = fourArgFunctionBody(migration)
    const prev = fourArgFunctionBody(previous)
    expect(next).not.toBe(prev)

    // 新版から #1791 の変更を逆適用すると、旧版と1文字違わず一致する。
    const reverted = next
      .replace(
        /  -- #1791: 除外条件を trade_copy_locked\(id\) に広げ[^\n]*\n  -- [^\n]*\n/,
        '',
      )
      .replace(
        '    AND NOT public.trade_copy_locked(id)\n  FOR UPDATE;',
        "    AND id NOT IN (\n      SELECT offered_user_card_id FROM public.trade_offers\n      WHERE offerer_user_id = v_user_id AND status = 'open'\n    )\n  FOR UPDATE;",
      )
      .replace(
        '      AND NOT public.trade_copy_locked(id)\n    ORDER BY',
        "      AND id NOT IN (\n        SELECT offered_user_card_id FROM public.trade_offers\n        WHERE offerer_user_id = v_user_id AND status = 'open'\n      )\n    ORDER BY",
      )
      .replace(/  -- #1791: 数え直しにも拘束判定を加える。[\s\S]*?CARD_NOT_OWNED になる。\n/, '')
      .replace(
        '    AND user_id = v_user_id\n    AND NOT public.trade_copy_locked(id);',
        '    AND user_id = v_user_id;',
      )
    expect(reverted).toBe(prev)
  })

  it('accept の拘束判定は (1) 全ロック・(2) 選定・(3) 数え直しの3か所すべてにある', () => {
    const body = code(fourArgFunctionBody(migration))
    expect(body.match(/NOT public\.trade_copy_locked\(id\)/g)).toHaveLength(3)
    // 旧来の「自分の open オファーだけを除外」は残っていない
    expect(body).not.toContain('id NOT IN (')
    // 返却JSONのキーとエラーコードは不変
    for (const key of [
      "'receivedUserCardId'", "'givenUserCardId'", "'offeredCardSnapshot'", "'wantedCardSnapshot'",
      "'completedAt'", "'idempotentReplay'", "'QUANTITY_MISMATCH'", "'WANTED_CARD_NOT_WANTABLE'",
      "'CARD_NOT_OWNED'", "'OFFER_INVALID'", "'TRADE_PAYER_TRANSFER_MISMATCH'",
    ]) {
      expect(body).toContain(key)
    }
  })

  it('3引数ラッパーは置き換えない', () => {
    expect(code(migration)).not.toMatch(
      /FUNCTION public\.accept_trade_offer\(\n  p_twitch_user_id text,\n  p_trade_offer_id uuid,\n  p_request_id uuid\n\)/,
    )
  })

  it('trade_offers の BEFORE INSERT トリガーは行ロック → 所有確認 → オークション拘束の順で P0001 を出す', () => {
    const start = migration.indexOf('CREATE FUNCTION public.trade_offers_enforce_copy_lock()')
    const body = code(migration.slice(start, migration.indexOf('$$;', start)))
    const lock = body.indexOf('FOR UPDATE')
    const owner = body.indexOf("MESSAGE = 'TRADE_CARD_NOT_OWNED'")
    const locked = body.indexOf("MESSAGE = 'TRADE_CARD_LOCKED'")
    expect(lock).toBeGreaterThan(0)
    expect(owner).toBeGreaterThan(lock)
    expect(locked).toBeGreaterThan(owner)
    expect(body).toContain("ERRCODE = 'P0001'")
    // 通常出品どうしの重複は既存の部分UNIQUE(23505)に任せる
    expect(body).toContain('public.trade_copy_auction_locked(NEW.offered_user_card_id)')
    expect(body).not.toContain('public.trade_copy_locked(')
    expect(migration).toContain(
      'CREATE TRIGGER trade_offers_enforce_copy_lock BEFORE INSERT ON public.trade_offers',
    )
  })

  it('拘束・時刻の判定関数は clock_timestamp() を使い VOLATILE と宣言する', () => {
    const holds = migration.slice(migration.indexOf('CREATE FUNCTION public.trade_auction_holds_cards'))
    expect(holds.slice(0, holds.indexOf('$$;'))).toContain('clock_timestamp()')
    expect(code(migration)).not.toMatch(/\bnow\(\) < |< now\(\)/)
    for (const fn of ['trade_auction_holds_cards', 'trade_copy_auction_locked', 'trade_copy_locked']) {
      expect(migration).toMatch(new RegExp(`CREATE FUNCTION public\\.${fn}\\(p_[a-z_]+ uuid\\) RETURNS boolean\\nLANGUAGE sql VOLATILE`))
    }
  })

  /** `CREATE FUNCTION public.<name>(` から `$$;` までの実行コード */
  function functionCode(name: string): string {
    const start = migration.indexOf(`CREATE FUNCTION public.${name}(`)
    expect(start).toBeGreaterThanOrEqual(0)
    const bodyStart = migration.indexOf('AS $$', start)
    return code(migration.slice(start, migration.indexOf('$$;', bodyStart)))
  }

  it('入札は出品コピーも同じ id 昇順のロックで取り、ロック取得後に締切と出品者の所有を再判定する(PR #1850 M1(a))', () => {
    const body = functionCode('place_trade_auction_bid')
    const lock = body.indexOf('OR id = v_auction.offered_user_card_id\n  ORDER BY id\n  FOR UPDATE;')
    expect(lock).toBeGreaterThan(0)
    const recheck = body.indexOf("IF clock_timestamp() >= v_auction.ends_at THEN\n    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_NOT_OPEN');")
    expect(recheck).toBeGreaterThan(lock)
    const ownership = body.indexOf('WHERE id = v_auction.offered_user_card_id AND user_id = v_auction.seller_user_id')
    expect(ownership).toBeGreaterThan(recheck)
    // 候補選定(書き込み前)より前に再判定する
    expect(body.indexOf('SELECT array_agg(candidate.id')).toBeGreaterThan(ownership)
  })

  it('成立は全コピーのロック取得後に選択期限を再判定し、他の拘束も防御的に確認する(PR #1850 M1(b))', () => {
    const body = functionCode('settle_trade_auction')
    const lock = body.indexOf('WHERE id = ANY (v_item_ids || v_auction.offered_user_card_id)\n  ORDER BY id\n  FOR UPDATE;')
    expect(lock).toBeGreaterThan(0)
    const recheck = body.indexOf("IF clock_timestamp() >= v_auction.selection_deadline THEN\n    RETURN jsonb_build_object('success', false, 'error', 'AUCTION_EXPIRED');", lock)
    expect(recheck).toBeGreaterThan(lock)
    expect(body.indexOf('UPDATE public.user_cards')).toBeGreaterThan(recheck)
    // 自分自身(このオークション・この入札)以外の拘束を見る
    expect(body).toContain('other_auction.id <> v_auction.id')
    expect(body).toContain('other_bid.id <> v_bid.id')
  })

  it('非加法的な文(DROP/RENAME/型変更/TRUNCATE)を含まない', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('../../scripts/lib/db-migrate-core')
    expect(core.detectNonAdditiveStatements(migration)).toEqual([])
  })

  it('新しいテーブル・関数はすべて runtime ロールだけに公開する', () => {
    for (const table of ['trade_auctions', 'trade_auction_bids', 'trade_auction_bid_items']) {
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`)
      expect(migration).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${table} TO service_role;`)
    }
    for (const signature of [
      'trade_auction_holds_cards(uuid)',
      'trade_copy_auction_locked(uuid)',
      'trade_copy_locked(uuid)',
      'trade_auction_bid_unsettleable_reason(uuid)',
      'create_trade_auction(text, uuid, integer, uuid)',
      'place_trade_auction_bid(text, uuid, uuid, smallint, uuid)',
      'withdraw_trade_auction_bid(text, uuid)',
      'cancel_trade_auction(text, uuid)',
      'settle_trade_auction(text, uuid, uuid, uuid)',
      'accept_trade_offer(text, uuid, uuid, smallint)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`)
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`)
    }
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.trade_offers_enforce_copy_lock() FROM PUBLIC, anon, authenticated;',
    )
  })

  it('入札枚数の上限はアプリの定数と一致する', async () => {
    const { TRADE_MAX_BID_QUANTITY, TRADE_MAX_ACTIVE_BIDS } = await import('@/lib/trade-auction')
    expect(migration).toContain(`CHECK (quantity BETWEEN 1 AND ${TRADE_MAX_BID_QUANTITY})`)
    expect(migration).toContain(`IF p_quantity < 1 OR p_quantity > ${TRADE_MAX_BID_QUANTITY} THEN`)
    expect(migration).toContain(`IF v_active_bids >= ${TRADE_MAX_ACTIVE_BIDS} THEN`)
  })

  it('出品期限と選択期間はアプリの定数と一致する', async () => {
    const { TRADE_AUCTION_DURATIONS_HOURS, TRADE_AUCTION_SELECTION_HOURS } = await import('@/lib/trade-auction')
    expect(migration).toContain(`IF p_duration_hours NOT IN (${TRADE_AUCTION_DURATIONS_HOURS.join(', ')}) THEN`)
    expect(migration).toContain(`v_ends_at + interval '${TRADE_AUCTION_SELECTION_HOURS} hours'`)
  })

  it('出品上限は通常出品とオークションで共用し、アプリの TRADE_MAX_OPEN_OFFERS と一致する', async () => {
    const { TRADE_MAX_OPEN_OFFERS } = await import('@/lib/trade')
    expect(migration).toContain(`IF v_open_count >= ${TRADE_MAX_OPEN_OFFERS} THEN`)
  })
})
