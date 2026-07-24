/**
 * cards-safe-columns.ts の withCardsBattleColumnFallback 単体テスト (#685)
 *
 * isMissingCardsBattleColumnError / CARDS_SAFE_COLUMNS 自体は既存の
 * cards-route-driver-parity.test.ts / dashboard-data-driver-parity.test.ts が
 * 実クエリ経由で間接的に検証しているため、ここでは #685 で新設した
 * withCardsBattleColumnFallback の制御フロー（成功・フォールバック・再送出）
 * のみを、Drizzle モックを介さず直接テストする。
 */
import { describe, it, expect, vi } from 'vitest'
import { isMissingCardsBattleColumnError, withCardsBattleColumnFallback } from '@/lib/db/cards-safe-columns'

function missingCardsBattleColumnError(column: string = 'hp') {
  return Object.assign(new Error(`column "${column}" of relation "cards" does not exist`), {
    code: '42703',
  })
}

/**
 * Drizzle が postgres.js のエラーを1段ラップした DrizzleQueryError を模倣する
 * （実際の drizzle-orm のクラス形状に合わせる: `{ query, params, cause }`。
 * SQLSTATE・列名を含む実メッセージは cause 側にのみ存在する）。
 */
function wrappedMissingCardsBattleColumnError(column: string = 'card_number') {
  const cause = Object.assign(new Error(`column "${column}" of relation "cards" does not exist`), {
    code: '42703',
  })
  const err = new Error(
    'Failed query: select "id", "streamer_id", ... from "cards" where ...\nparams: ...'
  ) as Error & { query: string; params: unknown[]; cause: unknown }
  err.query = 'select "id", "streamer_id" ... from "cards" where ...'
  err.params = ['11111111-1111-1111-1111-111111111111', true, 1000]
  err.cause = cause
  return err
}

// 2026-07 本番障害の回帰テスト: getActiveCardsForStreamer が
// 「column "card_number" ... does not
// exist」(SQLSTATE 42703) で失敗し、CARDS_SAFE_COLUMNS フォールバック
// (#685) が発動せずカード一覧が空表示になった。原因は Drizzle が
// postgres.js のエラーを DrizzleQueryError で `{ query, params, cause }` に
// 1段ラップし、SQLSTATE・実メッセージがトップレベルではなく cause 側にしか
// 無いこと。isMissingCardsBattleColumnError はトップレベルの
// code/message/details/hint しか見ていなかったため検知できなかった。
describe('isMissingCardsBattleColumnError: Drizzle にラップされたエラー（本番障害の回帰）', () => {
  it('ラップされた 42703 エラー（cause.code）を検知する', () => {
    expect(isMissingCardsBattleColumnError(wrappedMissingCardsBattleColumnError('card_number'))).toBe(true)
  })

  it('本番未デプロイ8列いずれでも、ラップされたエラーから検知できる', () => {
    const columns = ['card_number', 'hp', 'atk', 'def', 'spd', 'skill_type', 'skill_name', 'skill_power']
    for (const column of columns) {
      expect(isMissingCardsBattleColumnError(wrappedMissingCardsBattleColumnError(column))).toBe(true)
    }
  })

  it('実際の本番エラー形状（Cloudflare Workers Logs 実データ相当）を検知する', () => {
    // 実際に本番の Cloudflare Workers Logs から取得したエラーペイロード
    // ({ query, params, cause: { code: "42703", ... } }) の再現。ログの
    // JSON.stringify では cause.message が表示されない（postgres.js の
    // PostgresError は message を Error.prototype 経由で非列挙プロパティとして
    // 持つため、構造化ログのシリアライズで落ちる）が、これはログ表示上の
    // 制約であり、アプリ側が実際に catch するオブジェクトでは message は
    // 通常のプロパティアクセスで取得できる（postgres.js の実装:
    // `Object.assign(this, x)` で全フィールドを設定する）。
    const productionShapedError = {
      query: 'select "id", ..., "card_number", ..., "skill_power", ... from "cards" where ...',
      params: ['11111111-1111-1111-1111-111111111111', true, 1000],
      cause: {
        name: 'k',
        severity: 'ERROR',
        code: '42703',
        position: '127',
        file: 'parse_relation.c',
        routine: 'errorMissingColumn',
        message: 'column "card_number" of relation "cards" does not exist',
      },
    };
    expect(isMissingCardsBattleColumnError(productionShapedError)).toBe(true)
  })

  it('多重ラップ（cause.cause）でも検知できる', () => {
    const doublyWrapped = {
      message: 'outer wrapper',
      cause: wrappedMissingCardsBattleColumnError('skill_power'),
    }
    expect(isMissingCardsBattleColumnError(doublyWrapped)).toBe(true)
  })

  it('該当しない列のラップされたエラーは false のまま', () => {
    const cause = Object.assign(new Error('permission denied for table cards'), { code: '42501' })
    const err = Object.assign(new Error('Failed query: ...'), { cause })
    expect(isMissingCardsBattleColumnError(err)).toBe(false)
  })

  // 2026-07 Fable厳格レビュー指摘(中4)の回帰テスト: 「全階層のテキストを連結
  // してから判定する」実装だと、ラッパー層（DrizzleQueryError.message =
  // 実行された SQL 文そのもの）に判定対象の列名が偶然含まれているだけで、
  // cause が全く無関係のエラーでも誤検知してしまう。ここでは
  // ラッパーの message に "card_number" を含む SELECT 文を置きつつ、
  // cause は無関係な接続断エラー（列名にも言及しない）にし、false になる
  // ことを検証する（各階層は自分自身の code/message だけで独立に判定される
  // べき）。
  it('ラッパーのmessageに列名を含むSQL文があっても、causeが無関係なエラーならfalse', () => {
    const cause = Object.assign(new Error('connection closed'), { code: 'CONNECTION_CLOSED' })
    const err = Object.assign(
      new Error(
        'Failed query: select "id", "streamer_id", "card_number", "hp", "atk", "skill_power" from "cards" where ...'
      ),
      { query: 'select "id", ..., "card_number", ... from "cards" where ...', params: [], cause }
    )
    expect(isMissingCardsBattleColumnError(err)).toBe(false)
  })

  // 同様に、cause 自体が 42703 でも「対象8列とは無関係な列」の欠落であれば
  // false になるべき（ラッパーの SQL 文に card_number 等が写っているだけで
  // 誤って true にならないことの確認）。
  it('causeが42703でも対象8列以外の列名なら、ラッパーSQL文に列名が写っていてもfalse', () => {
    const cause = Object.assign(new Error('column "unrelated_column" of relation "cards" does not exist'), {
      code: '42703',
    })
    const err = Object.assign(
      new Error(
        'Failed query: select "id", "streamer_id", "card_number", "hp", "atk", "skill_power" from "cards" where ...'
      ),
      { query: 'select "id", ..., "card_number", ... from "cards" where ...', params: [], cause }
    )
    expect(isMissingCardsBattleColumnError(err)).toBe(false)
  })
})

describe('withCardsBattleColumnFallback', () => {
  it('初回試行が成功すればそのまま結果を返す（フォールバックは呼ばれない）', async () => {
    const attempt = vi.fn(async (useSafeColumns: boolean) =>
      useSafeColumns ? 'safe' : 'full'
    )

    const result = await withCardsBattleColumnFallback(attempt)

    expect(result).toBe('full')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(false)
  })

  it('本番未デプロイ8列由来のエラーなら useSafeColumns=true で再試行する', async () => {
    const attempt = vi.fn(async (useSafeColumns: boolean) => {
      if (!useSafeColumns) throw missingCardsBattleColumnError('hp')
      return 'safe'
    })

    const result = await withCardsBattleColumnFallback(attempt)

    expect(result).toBe('safe')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(attempt).toHaveBeenNthCalledWith(1, false)
    expect(attempt).toHaveBeenNthCalledWith(2, true)
  })

  it('8列のいずれでもエラーを検知する', async () => {
    const columns = ['card_number', 'hp', 'atk', 'def', 'spd', 'skill_type', 'skill_name', 'skill_power']
    for (const column of columns) {
      const attempt = vi.fn(async (useSafeColumns: boolean) => {
        if (!useSafeColumns) throw missingCardsBattleColumnError(column)
        return 'safe'
      })
      await expect(withCardsBattleColumnFallback(attempt)).resolves.toBe('safe')
    }
  })

  it('本番未デプロイ8列に該当しないエラーはフォールバックせずそのまま再送出する', async () => {
    const permissionError = Object.assign(new Error('permission denied'), { code: '42501' })
    const attempt = vi.fn(async () => {
      throw permissionError
    })

    await expect(withCardsBattleColumnFallback(attempt)).rejects.toBe(permissionError)
    // 該当しないエラーでは2回目の再試行（useSafeColumns=true）を行わない
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('フォールバック後（useSafeColumns=true）の失敗はそのまま再送出する（三度目の試行はしない）', async () => {
    const fallbackError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
    const attempt = vi.fn(async (useSafeColumns: boolean) => {
      if (!useSafeColumns) throw missingCardsBattleColumnError('hp')
      throw fallbackError
    })

    await expect(withCardsBattleColumnFallback(attempt)).rejects.toBe(fallbackError)
    expect(attempt).toHaveBeenCalledTimes(2)
  })
})
