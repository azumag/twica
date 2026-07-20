#!/usr/bin/env node

/**
 * 読み取り専用スナップショットトランザクションの共通wrapper / Issue #697 Chunk 1
 *
 * 背景:
 * cutover検証ツールは source（Supabase）・target（PlanetScale）双方に対して複数クエリを
 * 発行する（Layer 1: identity、Layer 2: schema、後続チャンクの Layer 3/4: 件数・checksum も
 * 同様）。個々のクエリを素朴に単発発行すると、クエリとクエリの間に他プロセスの書き込みが
 * 割り込み、「一貫した1時点のスナップショット」を比較しているという前提が崩れる
 * （例: identity行を読んだ直後に何らかの理由でDBが差し替わる、テーブルAの件数を数えた後に
 * テーブルBへ関連レコードが書き込まれる、等）。
 *
 * 本モジュールは `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` で開始したトランザクション
 * 内で callback を実行する `withReadOnlySnapshot(sql, callback)` を提供する。
 * REPEATABLE READ は「トランザクション開始時点のスナップショットを維持する」隔離レベルであり
 * （PostgreSQLのMVCC実装上、READ COMMITTEDと異なりトランザクション内の全クエリが同一
 * スナップショットを見る）、READ ONLY はこのスナップショット上での書き込みをPostgreSQL自身が
 * 拒否する（`ERROR: cannot execute INSERT/UPDATE/DELETE in a read-only transaction`）ため、
 * 検証ツールのバグで誤って書き込みクエリを紛れ込ませても、DBが即座に拒否する多重防御になる。
 *
 * 常にROLLBACKで終わる設計について（Issue #697本文の明示要求）:
 * read-onlyトランザクションはCOMMITしてもROLLBACKしても実害は無い（書き込みが無いため）。
 * それでも本実装は常にROLLBACKで終える。理由: 「書き込みが万一混入した場合に安全側へ倒れる」
 * ことを設計として保証するため（COMMITをデフォルトにしてしまうと、将来の実装ミスで書き込み文が
 * 紛れ込んだ場合にそれがそのままcommitされてしまう。ROLLBACK固定なら、READ ONLY制約をすり抜ける
 * 実装ミスがあったとしても、最後は必ず巻き戻る）。
 *
 * 実装方式: postgres.js の `sql.begin(options, fn)` は fn が正常終了すればCOMMIT、例外を
 * throwすればROLLBACKする（ライブラリの標準動作）。常にROLLBACKさせるため、callback の結果
 * （成功時の戻り値・失敗時の例外）を一旦キャプチャした上で、必ず専用のsentinel例外をthrowして
 * postgres.js側にROLLBACKさせ、sentinel自体は withReadOnlySnapshot の外側で捕捉して
 * 握りつぶし、キャプチャしておいた本来の結果/例外を呼び出し元へ伝播させる。
 */

// sentinelを一意に識別するためのSymbol（文字列比較ではなく参照比較にすることで、
// callback側が偶然同じmessageを持つ例外を投げても誤って握りつぶさないようにする）。
const FORCED_ROLLBACK = Symbol('withReadOnlySnapshot.forcedRollback')

/**
 * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` トランザクション内で callback を実行し、
 * 結果に関わらず必ずROLLBACKする。
 *
 * @template T
 * @param {import('postgres').Sql} sql postgres.js クライアント（source/targetそれぞれの接続）
 * @param {(tx: import('postgres').Sql) => Promise<T>} callback トランザクション内で実行する処理。
 *   引数 tx は sql.begin() が渡すトランザクションスコープの sql タグ関数（このtxを使って
 *   クエリを発行すること。外側の sql を直接使うとトランザクション外になり一貫性が崩れる）。
 * @returns {Promise<T>} callback の戻り値（ROLLBACKされてもJS側の戻り値としては正常に返る）
 * @throws callback が投げた例外はそのまま呼び出し元へ再スローされる（ROLLBACK後に）
 */
export async function withReadOnlySnapshot(sql, callback) {
  let capturedResult
  let capturedError
  // Minor-1（Fableレビュー）: `capturedError` の有無を「truthyかどうか」で判定すると、
  // callbackが `throw undefined` や `throw ''`（falsy値）した場合にエラーが無かったことに
  // なり握りつぶしてしまう。明示的な boolean フラグで「例外が発生したかどうか」自体を
  // 別途記録し、値そのものの真偽に依存しないようにする。
  let hasError = false
  let callbackRan = false

  try {
    await sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
      callbackRan = true
      try {
        capturedResult = await callback(tx)
      } catch (error) {
        hasError = true
        capturedError = error
      }
      // 成功・失敗いずれの場合も、必ずこのトランザクションをROLLBACKさせるため
      // sentinelをthrowする（ファイル冒頭コメント「実装方式」参照）。
      const rollbackSignal = new Error('withReadOnlySnapshot: intentional rollback')
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
    throw new Error('withReadOnlySnapshot: BEGIN succeeded but callback never ran (unexpected)')
  }

  if (hasError) throw capturedError
  return capturedResult
}
