import { describe, expect, it, vi } from 'vitest'
import { withReadOnlySnapshot } from '../../../scripts/db-cutover/snapshot.mjs'

/**
 * withReadOnlySnapshot（Issue #697 Chunk 1タスク5、共有read-onlyトランザクションwrapper）の
 * 単体テスト。実DB接続は使わず、postgres.jsの`sql.begin(options, fn)`と同じ契約を持つ
 * フェイクで検証する。
 *
 * フェイクの設計方針（Fableレビュー M-5対応で全面的に見直し）: postgres.jsの実際の`begin()`は
 * 「渡したfnが解決すればCOMMIT、rejectすればROLLBACK後に再throw」という契約を持つ
 * （node_modules/postgres/cjs/src/index.js を実査し、withReadOnlySnapshot実装時に確認済み）。
 * 当初のフェイクは単に `return fn(tx)` するだけで、fnが「成功」した場合に本来COMMITされるのか
 * ROLLBACKされるのかを一切観測していなかった。これは
 * withReadOnlySnapshotの中核設計（「callbackが成功しても後から必ずROLLBACKさせる」sentinel方式、
 * ファイル冒頭コメント参照）を全く検証できていないという指摘（レビューM-5）を受けたもの。
 * このフェイクは fn の resolve/reject を committed/rolledBack という observable な状態に
 * 変換することで、「withReadOnlySnapshotに渡した callback 自体が成功しても、実際に begin() に
 * 渡る関数（sentinelをthrowする）は必ずrejectし、結果としてCOMMITが一度も呼ばれないこと」を
 * 直接アサートできるようにする。
 */
function makeFakeSql(tx: unknown) {
  const beginCalls: Array<{ options: string }> = []
  let committed = false
  let rolledBack = false
  const begin = vi.fn(async (options: string, fn: (tx: unknown) => Promise<unknown>) => {
    beginCalls.push({ options })
    try {
      const result = await fn(tx)
      committed = true
      return result
    } catch (error) {
      rolledBack = true
      throw error
    }
  })
  return {
    sql: { begin },
    beginCalls,
    begin,
    getTxOutcome: () => ({ committed, rolledBack }),
  }
}

describe('withReadOnlySnapshot', () => {
  it('REPEATABLE READ READ ONLY で BEGIN する', async () => {
    const { sql, beginCalls } = makeFakeSql({})
    await withReadOnlySnapshot(sql as never, async () => 'ok')
    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0].options).toBe('ISOLATION LEVEL REPEATABLE READ READ ONLY')
  })

  it('callbackが成功してもトランザクションはCOMMITされずROLLBACKされる（常にROLLBACKする設計の中核保証、Fableレビュー M-5対応）', async () => {
    const { sql, getTxOutcome } = makeFakeSql({})
    const result = await withReadOnlySnapshot(sql as never, async () => 'ok')
    expect(result).toBe('ok')
    expect(getTxOutcome()).toEqual({ committed: false, rolledBack: true })
  })

  it('callbackが失敗した場合もトランザクションはROLLBACKされる（結果は元々ROLLBACKされるはずのケースなので新規性は無いが、成功時との対称性を明示するために残す）', async () => {
    const { sql, getTxOutcome } = makeFakeSql({})
    await expect(
      withReadOnlySnapshot(sql as never, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(getTxOutcome()).toEqual({ committed: false, rolledBack: true })
  })

  it('callbackの戻り値をそのまま返す', async () => {
    const { sql } = makeFakeSql({ marker: 'tx' })
    const result = await withReadOnlySnapshot(sql as never, async (tx) => {
      expect(tx).toEqual({ marker: 'tx' })
      return { value: 42 }
    })
    expect(result).toEqual({ value: 42 })
  })

  it('callbackに渡されるtxはsql.begin()が渡したtxそのもの', async () => {
    const txMarker = { id: 'tx-marker' }
    const { sql } = makeFakeSql(txMarker)
    let receivedTx: unknown
    await withReadOnlySnapshot(sql as never, async (tx) => {
      receivedTx = tx
    })
    expect(receivedTx).toBe(txMarker)
  })

  it('callbackが例外を投げた場合、その例外がそのまま呼び出し元へ伝播する', async () => {
    const { sql } = makeFakeSql({})
    const boom = new Error('boom')
    await expect(
      withReadOnlySnapshot(sql as never, async () => {
        throw boom
      })
    ).rejects.toBe(boom)
  })

  it('callbackが falsy 値（undefined）をthrowしても握りつぶさず伝播する（Minor-1、Fableレビュー対応）', async () => {
    // `if (capturedError)` のようなtruthy判定だと `throw undefined` を「エラー無し」と誤認して
    // capturedResult（undefined）を正常返却してしまう。明示的なhasErrorフラグでこれを防いでいる
    // ことを確認する回帰テスト。
    const { sql } = makeFakeSql({})
    await expect(
      withReadOnlySnapshot(sql as never, async () => {
        throw undefined
      })
    ).rejects.toBeUndefined()
  })

  it('sql.begin()自体が失敗した場合（BEGIN文の失敗等）、その例外がそのまま伝播する', async () => {
    const begin = vi.fn(async () => {
      throw new Error('connection refused')
    })
    await expect(withReadOnlySnapshot({ begin } as never, async () => 'unreachable')).rejects.toThrow(
      'connection refused'
    )
  })

  it('callbackが非同期に例外を投げても正しく伝播する（Promise chain経由）', async () => {
    const { sql } = makeFakeSql({})
    await expect(
      withReadOnlySnapshot(sql as never, async () => {
        await Promise.resolve()
        throw new Error('async boom')
      })
    ).rejects.toThrow('async boom')
  })

  it('callbackを一切呼ばずにbegin()が正常終了する異常系ではエラーを投げる（防御的アサーション）', async () => {
    const begin = vi.fn(async () => 'no callback invocation')
    await expect(withReadOnlySnapshot({ begin } as never, async () => 'unreachable')).rejects.toThrow(
      /callback never ran/
    )
  })
})
