import { describe, expect, it } from 'vitest'
import { getIssuanceInfo, isMissingCardIssuanceColumnError, parseCardIssuanceLimit } from '@/lib/card-issuance'

describe('parseCardIssuanceLimit', () => {
  it('treats empty values as unlimited', () => {
    expect(parseCardIssuanceLimit(undefined)).toBeNull()
    expect(parseCardIssuanceLimit(null)).toBeNull()
    expect(parseCardIssuanceLimit('')).toBeNull()
  })

  it('accepts positive integers', () => {
    expect(parseCardIssuanceLimit(1)).toBe(1)
    expect(parseCardIssuanceLimit(100)).toBe(100)
  })

  it('rejects non-positive or non-integer values', () => {
    expect(parseCardIssuanceLimit(0)).toBe('invalid')
    expect(parseCardIssuanceLimit(-1)).toBe('invalid')
    expect(parseCardIssuanceLimit(1.5)).toBe('invalid')
    expect(parseCardIssuanceLimit('100')).toBe('invalid')
  })

  // R4 (PR #450 レビュー follow-up): cards.max_issuance_count はDB側で4バイト
  // PostgreSQL INTEGER(最大2,147,483,647)。上限なしで受け付けると桁あふれで
  // 22003エラー→opaqueな500になるため、製品として現実的な上限
  // (1,000,000)でアプリ層が先に弾く。
  it('rejects values above the product cap (1,000,000) to avoid PostgreSQL INTEGER overflow (22003)', () => {
    expect(parseCardIssuanceLimit(1e12)).toBe('invalid')
    expect(parseCardIssuanceLimit(1_000_001)).toBe('invalid')
    // INTEGER自体の最大値を大きく超える入力も同様に拒否される
    expect(parseCardIssuanceLimit(2_147_483_648)).toBe('invalid')
  })

  it('accepts the product cap itself (1,000,000)', () => {
    expect(parseCardIssuanceLimit(1_000_000)).toBe(1_000_000)
  })
})

describe('isMissingCardIssuanceColumnError', () => {
  it('detects PostgREST schema-cache errors for max_issuance_count', () => {
    expect(isMissingCardIssuanceColumnError({
      code: 'PGRST204',
      message: "Could not find the 'max_issuance_count' column of 'cards' in the schema cache",
    })).toBe(true)
  })

  it('ignores unrelated missing-column errors', () => {
    expect(isMissingCardIssuanceColumnError({
      code: 'PGRST204',
      message: "Could not find the 'card_number' column of 'cards' in the schema cache",
    })).toBe(false)
  })

  // 2026-07 本番障害の回帰テスト: card-number-errors.ts と同じ pg 経路の
  // Drizzle ラップ問題（詳細は card-number-errors.test.ts / errors.ts 参照）。
  it('detects the error even when wrapped by Drizzle ({ query, params, cause })', () => {
    const wrapped = {
      query: 'insert into cards (...) returning *',
      params: [],
      cause: {
        code: '42703',
        message: 'column "max_issuance_count" of relation "cards" does not exist',
      },
    }
    expect(isMissingCardIssuanceColumnError(wrapped)).toBe(true)
  })

  // 2026-07 Fable厳格レビュー指摘(中4)の回帰テスト（詳細は
  // card-number-errors.test.ts の同種テスト参照）: ラッパー層の SQL 文に
  // "max_issuance_count" が含まれていても、cause が無関係なエラーなら false。
  it('ラッパーのINSERT文にmax_issuance_countが含まれても、causeが無関係なエラーならfalse', () => {
    const wrapped = {
      message: 'Failed query: insert into "cards" ("id", "max_issuance_count", "name") values (...)',
      query: 'insert into "cards" ("id", "max_issuance_count", "name") values (...)',
      params: [],
      cause: { code: 'CONNECTION_CLOSED', message: 'connection closed' },
    }
    expect(isMissingCardIssuanceColumnError(wrapped)).toBe(false)
  })
})

// Issue #542: CardManagerで発行済み枚数・残余枚数を表示する
describe('getIssuanceInfo', () => {
  it('returns null for unlimited cards (max_issuance_count is null/undefined)', () => {
    expect(getIssuanceInfo(null, 5)).toBeNull()
    expect(getIssuanceInfo(undefined, 5)).toBeNull()
  })

  it('reports neither soldOut nor lowRemaining well below the limit', () => {
    expect(getIssuanceInfo(10, 3)).toEqual({ max: 10, issued: 3, soldOut: false, lowRemaining: false })
  })

  it('treats a missing issued count as 0', () => {
    expect(getIssuanceInfo(10, null)).toEqual({ max: 10, issued: 0, soldOut: false, lowRemaining: false })
    expect(getIssuanceInfo(10, undefined)).toEqual({ max: 10, issued: 0, soldOut: false, lowRemaining: false })
  })

  // 受け入れ条件: 残り10%以下のカードに警告表示がある
  it('flags lowRemaining once remaining stock drops to 10% or below', () => {
    // 残り 1/10 = 10% ちょうど → 該当
    expect(getIssuanceInfo(10, 9)).toEqual({ max: 10, issued: 9, soldOut: false, lowRemaining: true })
    // 残り 2/10 = 20% → 非該当
    expect(getIssuanceInfo(10, 8)).toEqual({ max: 10, issued: 8, soldOut: false, lowRemaining: false })
  })

  it('flags soldOut once issued reaches the cap, and never both soldOut and lowRemaining', () => {
    expect(getIssuanceInfo(10, 10)).toEqual({ max: 10, issued: 10, soldOut: true, lowRemaining: false })
  })

  it('treats over-issued counts (e.g. concurrent legacy draws) as soldOut', () => {
    expect(getIssuanceInfo(10, 11)).toEqual({ max: 10, issued: 11, soldOut: true, lowRemaining: false })
  })

  it('handles a fully-unique card (max=1)', () => {
    // 未発行時点では残り100%なのでlowRemainingにはならない（発行された瞬間に即soldOutへ遷移する）
    expect(getIssuanceInfo(1, 0)).toEqual({ max: 1, issued: 0, soldOut: false, lowRemaining: false })
    expect(getIssuanceInfo(1, 1)).toEqual({ max: 1, issued: 1, soldOut: true, lowRemaining: false })
  })
})
