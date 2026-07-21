#!/usr/bin/env node

/**
 * 「必ずROLLBACKするトランザクション」の共通wrapper / Issue #697 Chunk 1 + Chunk 4
 *
 * 背景:
 * cutover検証ツールは source（Supabase）・target（PlanetScale）双方に対して複数クエリを
 * 発行する（Layer 1: identity、Layer 2: schema、Layer 3/4: 件数・checksum、Layer 5:
 * 業務invariant、Layer 6: canary）。個々のクエリを素朴に単発発行すると、クエリとクエリの間に
 * 他プロセスの書き込みが割り込み、「一貫した1時点のスナップショットを比較している」という
 * 前提が崩れる（例: identity行を読んだ直後に何らかの理由でDBが差し替わる、テーブルAの件数を
 * 数えた後にテーブルBへ関連レコードが書き込まれる、等）。
 *
 * 本モジュールは2種類のトランザクションwrapperを提供する。どちらも「callbackの結果に関わらず
 * 必ずROLLBACKする」という中核設計を共有するため、その機構を `withForcedRollbackTransaction`
 * （内部専用の共通関数、下記参照）として1箇所に切り出している（Issue #697 Chunk 4設計書
 * rev1レビューMinor-5対応: 当初は`canary-transaction.mjs`という新規ファイルにcanary専用の
 * 同種ロジックを複製する案だったが、sentinel機構（下記コメント参照）を約90行複製することになり、
 * 車輪の再発明・保守時の二重更新漏れリスクが生じるため、既存ファイルへの関数追加に変更した）:
 *
 *   - `withReadOnlySnapshot(sql, callback)`（Chunk 1、既存）: `BEGIN ISOLATION LEVEL
 *     REPEATABLE READ READ ONLY` で開始。identity/schema/data/invariants layer
 *     （読み取り専用の比較検証）が使う。
 *   - `withRollbackOnlyTransaction(sql, callback)`（Chunk 4、新規）: READ ONLY修飾子なしで
 *     `BEGIN`（デフォルトの READ COMMITTED・読み書き可能）。Layer 6（canary）が使う。
 *     canaryは`execute_gacha_transaction`等のRPCを実際に実行し、FOR UPDATEロック・
 *     トリガー発火・INSERT/UPDATEを本物に行う必要があるため、read-only制約を外す。
 *     その代わり「callbackが正常終了しても必ずROLLBACKする」という中核保証はそのまま
 *     維持することで、Issue #697本文の「canaryトランザクションはcommitしない」という
 *     安全要求を実装レベルで満たす（COMMITへ到達する経路が構造的に存在しない）。
 *
 * REPEATABLE READ は「トランザクション開始時点のスナップショットを維持する」隔離レベルであり
 * （PostgreSQLのMVCC実装上、READ COMMITTEDと異なりトランザクション内の全クエリが同一
 * スナップショットを見る）、READ ONLY はこのスナップショット上での書き込みをPostgreSQL自身が
 * 拒否する（`ERROR: cannot execute INSERT/UPDATE/DELETE in a read-only transaction`）ため、
 * 検証ツールのバグで誤って書き込みクエリを紛れ込ませても、DBが即座に拒否する多重防御になる
 * （`withRollbackOnlyTransaction`はcanaryが意図的に書き込みを行うためこの多重防御を持たないが、
 * 代わりに常時ROLLBACKという別の多重防御を持つ）。
 *
 * 常にROLLBACKで終わる設計について（Issue #697本文の明示要求）:
 * `withReadOnlySnapshot`が包む読み取り専用トランザクションはCOMMITしてもROLLBACKしても
 * 実害は無い（書き込みが無いため）。それでも本実装は常にROLLBACKで終える。理由:
 * 「書き込みが万一混入した場合に安全側へ倒れる」ことを設計として保証するため（COMMITを
 * デフォルトにしてしまうと、将来の実装ミスで書き込み文が紛れ込んだ場合にそのままcommitされて
 * しまう。ROLLBACK固定なら、READ ONLY制約をすり抜ける実装ミスがあったとしても、最後は必ず
 * 巻き戻る）。`withRollbackOnlyTransaction`はさらに一歩進んで、canaryが**意図的に**行う
 * 書き込み（fixture INSERT・RPC実行によるINSERT/UPDATE）を本物に実行させつつ、それでも
 * 必ず巻き戻すことで「新DBが実運用処理を実行できるか」を検証しながら実データへは
 * 一切影響を与えない、という一見相反する2つの要求を両立させる。
 *
 * 実装方式（sentinel握りつぶしパターン）: postgres.js の `sql.begin(options, fn)` は fn が
 * 正常終了すればCOMMIT、例外をthrowすればROLLBACKする（ライブラリの標準動作）。常に
 * ROLLBACKさせるため、callback の結果（成功時の戻り値・失敗時の例外）を一旦キャプチャした
 * 上で、必ず専用のsentinel例外をthrowしてpostgres.js側にROLLBACKさせ、sentinel自体は
 * `withForcedRollbackTransaction` の外側で捕捉して握りつぶし、キャプチャしておいた本来の
 * 結果/例外を呼び出し元へ伝播させる。
 */

// sentinelを一意に識別するためのSymbol（文字列比較ではなく参照比較にすることで、
// callback側が偶然同じmessageを持つ例外を投げても誤って握りつぶさないようにする）。
// withReadOnlySnapshot/withRollbackOnlyTransactionの両方でこの1つのSymbolを共有する
// （2つの独立したSymbolに分ける実益が無いため。sentinelは常に
// withForcedRollbackTransaction内部でthrow・同関数内でcatchされ、外部へ漏れることはない）。
const FORCED_ROLLBACK = Symbol('withForcedRollbackTransaction.forcedRollback')

/**
 * 「callbackの結果に関わらず必ずROLLBACKするトランザクション」を実行する内部共通関数。
 * `withReadOnlySnapshot`と`withRollbackOnlyTransaction`の両方がこの関数の上に実装されている
 * （ファイル冒頭コメント参照）。外部へは公開しない（`beginOptions`という実装詳細を
 * 呼び出し元に露出させないため、公開APIは常に用途別の具体的な関数名を使う）。
 *
 * @template T
 * @param {import('postgres').Sql} sql postgres.js クライアント（source/targetそれぞれの接続。
 *   トランザクションスコープの `tx` ではなく、トップレベルの `sql` を渡すこと。`tx`には
 *   `.begin()`メソッドが無いため、誤ってネストして渡した場合はpostgres.js側の
 *   TypeErrorとして即座に失敗する）
 * @param {string} beginOptions `sql.begin()`に渡すBEGIN修飾子文字列（例:
 *   `'ISOLATION LEVEL REPEATABLE READ READ ONLY'`）。空文字列を渡すとデフォルト
 *   （READ COMMITTED・読み書き可能）でBEGINする。
 * @param {(tx: import('postgres').Sql) => Promise<T>} callback トランザクション内で実行する処理。
 *   引数 tx は sql.begin() が渡すトランザクションスコープの sql タグ関数（このtxを使って
 *   クエリを発行すること。外側の sql を直接使うとトランザクション外になり一貫性が崩れる）。
 * @returns {Promise<T>} callback の戻り値（ROLLBACKされてもJS側の戻り値としては正常に返る）
 * @throws callback が投げた例外はそのまま呼び出し元へ再スローされる（ROLLBACK後に）
 */
async function withForcedRollbackTransaction(sql, beginOptions, callback) {
  let capturedResult
  let capturedError
  // Minor-1（Fableレビュー、Chunk 1）: `capturedError` の有無を「truthyかどうか」で判定すると、
  // callbackが `throw undefined` や `throw ''`（falsy値）した場合にエラーが無かったことに
  // なり握りつぶしてしまう。明示的な boolean フラグで「例外が発生したかどうか」自体を
  // 別途記録し、値そのものの真偽に依存しないようにする。
  let hasError = false
  let callbackRan = false

  try {
    await sql.begin(beginOptions, async (tx) => {
      callbackRan = true
      try {
        capturedResult = await callback(tx)
      } catch (error) {
        hasError = true
        capturedError = error
      }
      // 成功・失敗いずれの場合も、必ずこのトランザクションをROLLBACKさせるため
      // sentinelをthrowする（ファイル冒頭コメント「実装方式」参照）。
      const rollbackSignal = new Error('withForcedRollbackTransaction: intentional rollback')
      rollbackSignal[FORCED_ROLLBACK] = true
      throw rollbackSignal
    })
  } catch (error) {
    // sentinel以外（例: BEGIN自体が失敗した、接続が切れた等）はそのまま呼び出し元へ伝播する。
    if (!error || error[FORCED_ROLLBACK] !== true) {
      throw error
    }
  }

  // sql.begin() が一度も fn を呼ばずに例外を投げるケース（BEGIN文自体の失敗等）は
  // 上のcatchで再throwされ、ここには到達しない。callbackRanのチェックは
  // 「sentinelを握りつぶした後、本当にcallbackが走ったか」を明確にするための防御的アサーション。
  if (!callbackRan) {
    throw new Error('withForcedRollbackTransaction: BEGIN succeeded but callback never ran (unexpected)')
  }

  if (hasError) throw capturedError
  return capturedResult
}

/**
 * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` トランザクション内で callback を実行し、
 * 結果に関わらず必ずROLLBACKする（Layer 1/2/3/4/5が使う、読み取り専用の比較検証向け）。
 *
 * @template T
 * @param {import('postgres').Sql} sql postgres.js クライアント（source/targetそれぞれの接続）
 * @param {(tx: import('postgres').Sql) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withReadOnlySnapshot(sql, callback) {
  return withForcedRollbackTransaction(sql, 'ISOLATION LEVEL REPEATABLE READ READ ONLY', callback)
}

/**
 * `BEGIN`（READ ONLY修飾子なし、デフォルトのREAD COMMITTED・読み書き可能）トランザクション内で
 * callback を実行し、結果に関わらず必ずROLLBACKする（Layer 6: canaryが使う）。
 *
 * READ ONLYを外す理由: canaryは`execute_gacha_transaction`等のRPCを実際に呼び出し、
 * fixture行のINSERT・FOR UPDATEロック・トリガー発火によるUPDATE/INSERTを本物に実行する
 * 必要がある（「新DBが実運用処理を実行できるか」を検証する、というcanaryの目的そのもの）。
 * 一方で、これらの書き込みが実データへ影響しないことを保証するため、
 * `withForcedRollbackTransaction`が持つ「callbackの結果に関わらず必ずROLLBACKする」機構は
 * そのまま流用する。COMMITへ到達するコードパスが構造的に存在しないため、Issue #697本文の
 * 「canaryトランザクションはcommitしない」という安全要求を実装レベルで満たす。
 *
 * statement_timeoutの固定について（Issue #697 Chunk 4設計書「CLI統合の残ギャップ」節）:
 * canaryは複数のSQL（fixture INSERT・RPC呼び出し・トリガー発火の副作用SELECT等）を
 * 1トランザクション内で逐次実行するため、想定外の理由でクエリが長時間ブロックした場合
 * （例: fixtureに使ったIDが本物のロック待ちと衝突する等の極端なケース）に検証プロセス全体が
 * 無期限にハングするリスクがある。`SET LOCAL statement_timeout`はトランザクション内限定
 * （トランザクション終了時に自動的に元の値へ戻る、`00051_add_card_owner_stats.sql`の
 * `SET LOCAL statement_timeout = 0`と同じ仕組み）で安全に設定できるため、BEGIN直後・
 * callback実行前に固定値（60秒）を設定する。CLIオプション化はYAGNI（設計書「非スコープ」節）:
 * canaryが発行するSQLは全てfixture規模（数行）のシンプルなクエリであり、60秒は
 * 通常実行時間に対して十分な余裕を持つ固定の安全弁として機能する。
 *
 * @template T
 * @param {import('postgres').Sql} sql postgres.js クライアント（canaryはtarget接続のみに使う。
 *   ファイル冒頭コメント・layer-canary.mjs参照）
 * @param {(tx: import('postgres').Sql) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function withRollbackOnlyTransaction(sql, callback) {
  return withForcedRollbackTransaction(sql, '', async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '60s'`)
    return callback(tx)
  })
}
