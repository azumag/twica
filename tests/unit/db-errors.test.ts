import { describe, it, expect } from 'vitest'
import {
  getErrorChain,
  isPgFunctionNotFoundError,
  isPgMissingColumnError,
  isPgMissingNamedColumnError,
  isPgMissingTableError,
  isPgUniqueViolationError,
} from '@/lib/db/errors'

/** postgres.js が throw するエラー（code = SQLSTATE）を模倣する */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`SQLSTATE ${code}`), { code })
}

/**
 * Drizzle の DrizzleQueryError を模倣する（実際の drizzle-orm のクラス形状に
 * 合わせる: `{ query, params, cause }`。code/message は cause 側にのみ存在する）。
 */
function drizzleWrappedError(cause: unknown): Error & { query: string; params: unknown[]; cause: unknown } {
  const err = new Error('Failed query: select 1\nparams:') as Error & {
    query: string
    params: unknown[]
    cause: unknown
  }
  err.query = 'select 1'
  err.params = []
  err.cause = cause
  return err
}

describe('db/errors SQLSTATE 判定', () => {
  it('isPgMissingColumnError: 42703 のみ true', () => {
    expect(isPgMissingColumnError(pgError('42703'))).toBe(true)
    expect(isPgMissingColumnError(pgError('42P01'))).toBe(false)
    expect(isPgMissingColumnError(pgError('23505'))).toBe(false)
  })

  it('isPgFunctionNotFoundError: 42883 のみ true', () => {
    expect(isPgFunctionNotFoundError(pgError('42883'))).toBe(true)
    expect(isPgFunctionNotFoundError(pgError('42703'))).toBe(false)
  })

  it('isPgMissingTableError: 42P01 のみ true', () => {
    expect(isPgMissingTableError(pgError('42P01'))).toBe(true)
    expect(isPgMissingTableError(pgError('42703'))).toBe(false)
  })

  it('isPgUniqueViolationError: 23505 のみ true', () => {
    expect(isPgUniqueViolationError(pgError('23505'))).toBe(true)
    expect(isPgUniqueViolationError(pgError('42703'))).toBe(false)
  })
})

describe('isPgMissingNamedColumnError', () => {
  it('同じエラー階層に42703と対象列名がある場合だけtrue', () => {
    expect(
      isPgMissingNamedColumnError(
        Object.assign(new Error('column "gacha_sound_rules" does not exist'), {
          code: '42703',
        }),
        ['gacha_sound_rules'],
      ),
    ).toBe(true)
    expect(
      isPgMissingNamedColumnError(
        Object.assign(new Error('column "other_column" does not exist'), {
          code: '42703',
        }),
        ['gacha_sound_rules'],
      ),
    ).toBe(false)
  })

  it('Drizzle wrapperのSQLに列名があってもcauseが別列ならfalse', () => {
    const wrapper = drizzleWrappedError(
      Object.assign(new Error('column "other_column" does not exist'), {
        code: '42703',
      }),
    )
    wrapper.message =
      'Failed query: update "streamers" set "gacha_sound_rules" = $1, "other_column" = $2'

    expect(isPgMissingNamedColumnError(wrapper, ['gacha_sound_rules'])).toBe(false)
  })

  it('接続障害・空の列名配列・unknown入力を安全に拒否する', () => {
    expect(
      isPgMissingNamedColumnError(
        Object.assign(new Error('connection closed'), { code: '08006' }),
        ['gacha_sound_rules'],
      ),
    ).toBe(false)
    expect(isPgMissingNamedColumnError(pgError('42703'), [])).toBe(false)
    expect(isPgMissingNamedColumnError(null, ['gacha_sound_rules'])).toBe(false)
  })
})

// 2026-07 本番障害の回帰テスト: Drizzle は postgres.js のエラーを
// DrizzleQueryError で `{ query, params, cause }` の形に1段ラップする。
// SQLSTATE (42703) はトップレベルの code ではなく cause.code にあるため、
// トップレベルのみを見る判定は #685 のデプロイ窓フォールバックを発動できず、
// getActiveCardsForStreamer (pg) がカード一覧を空で返す障害になった。
describe('db/errors: Drizzle にラップされたエラー（cause チェーン）', () => {
  it('isPgMissingColumnError: cause.code = 42703 を検知する', () => {
    expect(isPgMissingColumnError(drizzleWrappedError(pgError('42703')))).toBe(true)
  })

  it('isPgFunctionNotFoundError: cause.code = 42883 を検知する', () => {
    expect(isPgFunctionNotFoundError(drizzleWrappedError(pgError('42883')))).toBe(true)
  })

  it('isPgMissingTableError: cause.code = 42P01 を検知する', () => {
    expect(isPgMissingTableError(drizzleWrappedError(pgError('42P01')))).toBe(true)
  })

  it('isPgUniqueViolationError: cause.code = 23505 を検知する', () => {
    expect(isPgUniqueViolationError(drizzleWrappedError(pgError('23505')))).toBe(true)
  })

  it('無関係な cause.code では引き続き false（誤検知しない）', () => {
    expect(isPgMissingColumnError(drizzleWrappedError(pgError('23505')))).toBe(false)
  })

  it('多重ラップ（cause.cause）でも検知できる', () => {
    expect(isPgMissingColumnError(drizzleWrappedError(drizzleWrappedError(pgError('42703'))))).toBe(true)
  })

  // 実際に本番の Cloudflare Workers Logs で観測されたエラー形状の再現。
  // トップレベルに code は無く、cause に SQLSTATE と PostgreSQL の生エラー
  // フィールド（severity/position/file/routine）だけがある（message は
  // postgres.js の PostgresError では Error.prototype 由来の非列挙プロパティ
  // のため、構造化ログの JSON.stringify では欠落する。プロパティとしては
  // 存在するため、判定関数からは通常どおり参照できる）。
  it('実際の本番エラー形状（query/params/cause、cause に message なし）でも 42703 を検知する', () => {
    const productionShapedError = {
      query:
        'select "id", "streamer_id", "name", "description", "image_url", "rarity", "rarity_order", "drop_rate", "intra_rarity_weight", "max_issuance_count", "collection_name", "card_number", "hp", "atk", "def", "spd", "skill_type", "skill_name", "skill_power", "is_active", "created_at", "updated_at" from "cards" where (...)',
      params: ['11111111-1111-1111-1111-111111111111', true, 1000],
      cause: {
        name: 'k',
        severity: 'ERROR',
        code: '42703',
        position: '127',
        file: 'parse_relation.c',
        routine: 'errorMissingColumn',
      },
    }
    expect(isPgMissingColumnError(productionShapedError)).toBe(true)
  })
})

describe('getErrorChain', () => {
  it('生のエラー（cause なし）はチェーン長 1 で自分自身のみを返す', () => {
    const err = new Error('boom')
    expect(getErrorChain(err)).toEqual([err])
  })

  it('cause を持つエラーは [error, cause] の順で返す', () => {
    const cause = pgError('42703')
    const err = drizzleWrappedError(cause)
    expect(getErrorChain(err)).toEqual([err, cause])
  })

  it('多重ラップは [error, cause1, cause2, ...] の順で全階層を返す', () => {
    const innermost = pgError('42703')
    const middle = drizzleWrappedError(innermost)
    const outer = drizzleWrappedError(middle)
    expect(getErrorChain(outer)).toEqual([outer, middle, innermost])
  })

  it('既定の最大深さ（5階層）を超えるチェーンは打ち切る', () => {
    // 8階層のラップを作る（0番目が最も外側）
    let current: unknown = { layer: 7 }
    for (let i = 6; i >= 0; i--) {
      current = { layer: i, cause: current }
    }
    const chain = getErrorChain(current)
    expect(chain.length).toBe(6) // maxDepth=5 → 0..5 の6要素
    expect((chain[0] as { layer: number }).layer).toBe(0)
    expect((chain[5] as { layer: number }).layer).toBe(5)
  })

  it('循環参照があっても無限ループせず打ち切る', () => {
    const circular: Record<string, unknown> = { code: 'X' }
    circular.cause = circular
    expect(getErrorChain(circular)).toEqual([circular])
  })

  it('null / undefined は空配列を返す', () => {
    expect(getErrorChain(null)).toEqual([])
    expect(getErrorChain(undefined)).toEqual([])
  })

  it('プリミティブ（文字列等）は自分自身のみの1要素チェーン', () => {
    expect(getErrorChain('CONNECTION_CLOSED')).toEqual(['CONNECTION_CLOSED'])
  })
})

describe('db/errors unknown 安全性', () => {
  const guards = [
    isPgMissingColumnError,
    isPgFunctionNotFoundError,
    isPgMissingTableError,
    isPgUniqueViolationError,
  ]

  it.each(guards.map((g) => [g.name, g] as const))(
    '%s は null / undefined / 文字列 / code なしでも例外を出さず false',
    (_name, guard) => {
      expect(guard(null)).toBe(false)
      expect(guard(undefined)).toBe(false)
      expect(guard('42703')).toBe(false)
      expect(guard(42703)).toBe(false)
      expect(guard(new Error('no code'))).toBe(false)
      // code が数値（SQLSTATE は文字列でなければならない）
      expect(guard(Object.assign(new Error('x'), { code: 42703 }))).toBe(false)
    }
  )
})
