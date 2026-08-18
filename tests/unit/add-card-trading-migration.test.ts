import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  join(process.cwd(), 'db/planetscale/migrations/20260817100000_add_card_trading.sql'),
  'utf8',
)

describe('add card trading migration', () => {
  it('PlanetScale transaction migrationとして宣言する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
  })

  it('PlanetScale移行後の方針どおりRLSやSECURITY DEFINERに依存しない', () => {
    // twica_appはBYPASSRLSを持つためRLSポリシーは実効性が無く、
    // 呼び出しロールが既にservice_role相当のフルアクセスを持つため
    // SECURITY DEFINERによる昇格も不要(migration冒頭のコメントで明記済み。
    // その説明コメント自体がこの2語をbacktick付きで言及するため、コメント行を
    // 除いた実コード側にのみ現れないことを検証する)。
    const codeOnly = migration
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')

    expect(codeOnly).not.toContain('ENABLE ROW LEVEL SECURITY')
    expect(codeOnly).not.toContain('SECURITY DEFINER')
  })

  it('支払いカードのUPDATEに所有者条件とROW_COUNTチェックを付け、出品カードのUPDATEより先に実行する', () => {
    const payerUpdate = migration.indexOf(
      'UPDATE user_cards SET user_id = v_offer.offerer_user_id',
    )
    const payerDiagnostics = migration.indexOf(
      'GET DIAGNOSTICS v_payer_update_count = ROW_COUNT',
    )
    const offeredCardUpdate = migration.indexOf(
      'WHERE id = v_offer.offered_user_card_id',
      payerUpdate,
    )

    expect(payerUpdate).toBeGreaterThan(0)
    // 支払いカード候補の選定SELECTはFOR UPDATEを付けないため、実際の所有権
    // 移転UPDATEはuser_id条件付きで書き、ROW_COUNTが0なら並行acceptに
    // 奪われたとみなしてfail-closedする(この最終防御が今回の修正の核心)。
    expect(migration.slice(payerUpdate, payerUpdate + 200)).toContain('AND user_id = v_user_id')
    expect(payerDiagnostics).toBeGreaterThan(payerUpdate)

    // 支払いカード側のUPDATEは、出品カード側のUPDATE(WHERE id = v_offer.offered_user_card_id)
    // より前に出現しなければならない。この順序が「失敗時に部分的な副作用を
    // 残さない」という修正の要であり、逆順に巻き戻されていないことを保証する。
    expect(offeredCardUpdate).toBeGreaterThan(payerDiagnostics)
  })

  it('冪等リプレイ判定を二重成立防止の検証より前に行う', () => {
    const idempotentCheck = migration.indexOf('accepted_request_id = p_request_id')
    const doubleAcceptCheck = migration.indexOf("v_offer.status <> 'open'")

    expect(idempotentCheck).toBeGreaterThan(0)
    expect(doubleAcceptCheck).toBeGreaterThan(0)
    expect(idempotentCheck).toBeLessThan(doubleAcceptCheck)
  })

  it('is_cross_channelを生成列にして非正規化不整合を排除する', () => {
    expect(migration).toContain(
      'is_cross_channel boolean GENERATED ALWAYS AS (offered_streamer_id <> wanted_streamer_id) STORED',
    )
  })

  it('二重出品防止と作成冪等性のための部分UNIQUEインデックスを持つ', () => {
    expect(migration).toContain('idx_trade_offers_open_user_card')
    expect(migration).toContain('idx_trade_offers_offerer_request')
  })

  it('trade_offers/accept_trade_offerをruntimeロールだけに公開する', () => {
    expect(migration).toContain('REVOKE ALL ON TABLE public.trade_offers FROM PUBLIC, anon, authenticated')
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_offers TO service_role')
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.accept_trade_offer(text, uuid, uuid) FROM PUBLIC, anon, authenticated',
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.accept_trade_offer(text, uuid, uuid) TO service_role',
    )
  })
})
