import { describe, expect, it, vi } from 'vitest'
import { withReadOnlySnapshot, withRollbackOnlyTransaction } from '../../../scripts/db-cutover/snapshot.mjs'

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

/**
 * withRollbackOnlyTransaction（Issue #697 Chunk 4、canary専用の「READ ONLYなし・必ずROLLBACK」
 * トランザクションwrapper）の単体テスト。
 *
 * withReadOnlySnapshotと共有する内部機構（withForcedRollbackTransaction、sentinel握りつぶし
 * パターン）についての「正常/例外」ケースはwithReadOnlySnapshot側のテストで既に厚くカバー
 * されているため、ここでは重複を避け、withRollbackOnlyTransaction固有の差分
 * （READ ONLY修飾子が付かないこと・statement_timeoutのSET LOCALを行うこと）と、
 * 「正常/例外/ネスト拒否」の3ケースに絞って検証する。
 *
 * fakeTxが`unsafe`メソッドを持つ理由: withRollbackOnlyTransactionはBEGIN直後・callback実行前に
 * `tx.unsafe("SET LOCAL statement_timeout = '60s'")`を発行するため、withReadOnlySnapshotの
 * テストが使うfakeTx（`unsafe`を持たないプレーンオブジェクト）をそのまま流用すると
 * `tx.unsafe is not a function`で全テストが落ちてしまう。
 */
function makeFakeSqlWithUnsafeTx() {
  const unsafeCalls: string[] = []
  const tx = {
    unsafe: vi.fn(async (sqlText: string) => {
      unsafeCalls.push(sqlText)
      return []
    }),
  }
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
    tx,
    beginCalls,
    unsafeCalls,
    getTxOutcome: () => ({ committed, rolledBack }),
  }
}

describe('withRollbackOnlyTransaction（Issue #697 Chunk 4）', () => {
  it('READ ONLY修飾子なし（空文字列）でBEGINする', async () => {
    const { sql, beginCalls } = makeFakeSqlWithUnsafeTx()
    await withRollbackOnlyTransaction(sql as never, async () => 'ok')
    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0].options).toBe('')
  })

  it('BEGIN直後・callback実行前にSET LOCAL statement_timeoutを固定値(60s)で発行する', async () => {
    // Fableレビュー Minor対応: 以前はcallback完了後にunsafeCallsの件数・内容だけを
    // 検証しており、「SET LOCALをcallback実行より後に移す」という退行があっても
    // 最終的な件数・内容は変わらないため検出できなかった（順序を実際にはassertして
    // いなかった）。callback**の内部**で`unsafeCalls`の状態を検査することで、
    // 「callbackが呼ばれた時点で、既にSET LOCALが発行済みであること」という
    // 順序そのものを直接検証する。
    const { sql, unsafeCalls } = makeFakeSqlWithUnsafeTx()
    let assertedInsideCallback = false
    await withRollbackOnlyTransaction(sql as never, async () => {
      // ここに到達した時点でSET LOCALが完了していなければならない。
      expect(unsafeCalls).toHaveLength(1)
      expect(unsafeCalls[0]).toContain('statement_timeout')
      expect(unsafeCalls[0]).toContain('60s')
      assertedInsideCallback = true
      return 'ok'
    })
    // callback自体が本当に呼ばれ、上記assertionを通過したことの防御的確認
    // （callbackが呼ばれずに終わるとテストが偽陽性でpassしてしまうことを防ぐ）。
    expect(assertedInsideCallback).toBe(true)
    // callback完了後もunsafeCallsが1件のまま（callback内で新たなunsafe呼び出しは
    // 発生していない）ことの最終確認。
    expect(unsafeCalls).toHaveLength(1)
  })

  it('callbackが成功してもトランザクションはCOMMITされずROLLBACKされる（withReadOnlySnapshotと同じ中核保証）', async () => {
    const { sql, getTxOutcome } = makeFakeSqlWithUnsafeTx()
    const result = await withRollbackOnlyTransaction(sql as never, async () => 'ok')
    expect(result).toBe('ok')
    expect(getTxOutcome()).toEqual({ committed: false, rolledBack: true })
  })

  it('callbackが例外を投げた場合もROLLBACKされ、例外がそのまま呼び出し元へ伝播する', async () => {
    const { sql, getTxOutcome } = makeFakeSqlWithUnsafeTx()
    const boom = new Error('canary check failed')
    await expect(
      withRollbackOnlyTransaction(sql as never, async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(getTxOutcome()).toEqual({ committed: false, rolledBack: true })
  })

  it('callbackへ渡されるtxはsql.begin()が渡したtxそのもの', async () => {
    const { sql, tx } = makeFakeSqlWithUnsafeTx()
    let receivedTx: unknown
    await withRollbackOnlyTransaction(sql as never, async (t) => {
      receivedTx = t
    })
    expect(receivedTx).toBe(tx)
  })

  it('ネスト拒否: savepointスコープのtx等、.beginを持たないオブジェクトを渡すと明示的に失敗する（誤ってネストできないことの確認）', async () => {
    // withRollbackOnlyTransactionは必ずトップレベルのsql（.beginを持つ）を受け取る契約であり、
    // savepointスコープのtx（.beginを持たない、.savepointのみ持つ）を誤って渡した場合に
    // 静かに成功してしまう（トランザクションのネストが意図せず起きる）ことがないよう、
    // postgres.js自体のTypeError（`tx.begin is not a function`相当）がそのまま伝播することを
    // 確認する。呼び出し側コード（layer-canary.mjs）がこの契約を誤って破った場合の
    // フェイルファスト性を保証する回帰テスト。
    const savepointScopedTx = { savepoint: vi.fn() }
    await expect(withRollbackOnlyTransaction(savepointScopedTx as never, async () => 'unreachable')).rejects.toThrow(
      /begin is not a function/
    )
  })
})
