import 'server-only'

/**
 * Error Reporting Abstraction Layer
 * エラーレポート抽象レイヤー
 *
 * Sentry SDK was removed to reduce bundle size for Cloudflare Workers deployment
 * (Sentry was duplicated 4x by Turbopack, consuming ~16.8MB of the 23MB bundle).
 * This layer is maintained as an abstraction so that error monitoring can be
 * re-enabled by changing only the implementation in this file.
 *
 * 現在の実装: console.error + errors テーブルへの記録
 * DB に記録されたエラーは Cron Worker (twica-error-reporter) が
 * 定期的に読み出して GitHub Issue を自動作成する。
 *
 * See: https://github.com/azumag/twica/issues/235 (Sentry削除)
 * See: https://github.com/azumag/twica/issues/239 (エラー監視再導入)
 */

/**
 * errors テーブルへの記録方針:
 * - `server-only`境界内（Cloudflare Workers / Next.js server）でのみ動作
 * - Client Componentは共有console loggerだけを使用し、このmoduleをimportしない
 * - DB への記録失敗はメインのエラー処理を阻害しない
 * - PlanetScale/Drizzle の単一経路で errors テーブルへ記録する
 *
 * dynamic import する理由:
 * - 通常ログではDB moduleをロードせず、永続化が必要になった時だけ初期化する
 * - db/retry.ts → logger.server.ts → 本moduleの循環を初期評価時に作らない
 *
 * 機密情報マスキング:
 * - sanitizeContext / extractErrorMessage / sanitizeErrorText は log-sanitizer.ts に集約
 * - 同じユーティリティを logger.ts も使用しており、console 経路 / DB 記録経路で
 *   同一ポリシーが適用される（Issue #401）
 * - Sensitive-info masking lives in log-sanitizer so both the console pipeline
 *   (logger) and the database pipeline use the same redaction policy.
 */

import { resolveAppEnvironment } from '@/lib/app-environment'
import {
  sanitizeContext,
  sanitizeErrorStack,
  sanitizeErrorText,
  sanitizeLogArg,
  extractErrorMessage,
} from '@/lib/log-sanitizer'
import { getErrorChain, getSqlState } from '@/lib/db/errors'
import type { Json } from '@/types/database'

/**
 * error から message と stack を統一的に解決する。
 * 全 report*Error 関数の if/else 分岐を集約し DRY 原則を維持する。
 */
function resolveErrorInfo(error: unknown): { message: string; stack: string | null; isErrorInstance: boolean } {
  if (error instanceof Error) {
    return {
      message: sanitizeErrorText(error.message),
      stack: error.stack ? sanitizeErrorStack(error.stack, error.name, error.message) : null,
      isErrorInstance: true,
    }
  }
  return { message: extractErrorMessage(error), stack: null, isErrorInstance: false }
}

// PostgreSQL TEXT 型は最大1GBだが、実用的な上限として定数化
const MAX_MESSAGE_LENGTH = 10000
const MAX_STACK_LENGTH = 50000

// context に補完する cause メッセージの長さ上限。最深 cause は通常 postgres.js の
// PostgresError（短い1行文）だが、想定外の長大な message が来ても errors テーブルと
// error-reporter が生成する Issue 本文（context は先頭2000文字で切り出される）を
// 圧迫しないよう打ち切る。
const MAX_CAUSE_MESSAGE_LENGTH = 500

/**
 * #2094: エラーの cause チェーンから観測用の最小情報を取り出し、
 * errors.context へ補完するためのキー/値を返す。
 *
 * 背景: Drizzle は postgres.js のエラーを DrizzleQueryError で1段ラップする。
 * その message は `Failed query: <SQL全文>\nparams: <params>` であり、本当の
 * 失敗理由（SQLSTATE と DB 側のエラーメッセージ）は `cause`（postgres.js の
 * PostgresError / 接続系エラー）にだけ存在する。従来 errors テーブルには
 * トップレベルの message と stack のみが残り、GitHub Issue 自動起票にも
 * 根本原因が載らず原因推定を強いられた。ここでは同じ欠落を再発させないため、
 * getSqlState（チェーン全体から最初に見つかった code）と最深 cause の
 * message だけを記録する。
 *
 * 記録しないもの: DrizzleQueryError の message（SQL 全文）と stack、および
 * チェーン中間層の詳細。これらを context へ複写すると errors テーブルと
 * Issue 本文が SQL 全文で膨らむため、要約された2キーに限定する。
 *
 * 注意: chain.length === 1（cause 無し）では最深層＝エラー自身であり、その
 * message は errors.message に既に記録されるため causeMessage は付けない。
 */
function errorCauseContext(error: unknown): Record<string, unknown> {
  const derived: Record<string, unknown> = {}
  const sqlState = getSqlState(error)
  if (sqlState) derived.sqlState = sqlState

  const chain = getErrorChain(error)
  if (chain.length < 2) return derived

  const deepest = chain[chain.length - 1]
  // 最深層が Error / PostgresError 相当なら message、文字列 cause ならその文字列を
  // 使う。message を持たないオブジェクト（稀なラップ形）は JSON 化すると巨大に
  // なり得るため記録しない。
  let causeMessage: string | null = null
  if (typeof deepest === 'string') {
    causeMessage = deepest
  } else if (typeof deepest === 'object' && deepest !== null) {
    const message = (deepest as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') causeMessage = message
  }
  if (causeMessage) {
    derived.causeMessage = sanitizeErrorText(causeMessage).slice(0, MAX_CAUSE_MESSAGE_LENGTH)
  }
  return derived
}

function persistedContext(context: Record<string, unknown>): Json {
  // Drizzle intentionally accepts only JSON-compatible values for jsonb.  A
  // stringify/parse round-trip both validates the runtime value and removes
  // unsupported `undefined` properties before the insert; the cast is safe
  // because JSON.parse can only produce the Json union declared by the schema.
  const serialized = JSON.stringify(sanitizeContext(context))
  return JSON.parse(serialized) as Json
}

/**
 * 再入ガード (#711 C 必須付帯作業「再入ガード + 不変条件コメント」)。
 *
 * 不変条件: src/lib/db/retry.ts の全ログ呼び出しは logger.warn のみを使用し、
 * logger.error（→ logger.server.ts → logErrorFromLogger() → この関数）を
 * 一度も呼ばない。したがって通常運用でこのガードが発火することはなく、将来
 * insert 経路（withDbRetry の queryFn 内やその周辺）に logger.error 等が
 * 混入した場合に無限再帰・スタック枯渇を防ぐための保険としてのみ機能する。
 *
 * 実装に AsyncLocalStorage を使う理由: 過去に message ベースの fingerprint
 * Set (`activePersistenceKeys`) で同じ保護を実装したことがあるが（commit
 * 9d5ebea "fix: preserve concurrent error records"）、「別リクエストで同一
 * 内容のエラーが並行発生した」正当なケースまで再帰と誤判定し記録を欠落させる
 * バグがあったため撤去された。AsyncLocalStorage は「呼び出しの実行チェーン」
 * 単位でコンテキストを分離するため、同一チェーン内での真の再帰（insert 経路の
 * 実行中に何らかの理由で自分自身が再度呼ばれるケース）だけを検知でき、独立した
 * 並行呼び出し（内容が同じでも呼び出しチェーンが別）には一切干渉しない。
 * 下記 sentry-error-handler.test.ts の「別requestで並行発生した同一内容の
 * エラーをどちらも記録する」テストがこの非干渉性を固定する回帰テスト。
 *
 * 型注釈のみの `import('node:async_hooks')`（下の Promise<...> 型引数）はコンパイル
 * 時に消去される。実体のdynamic importはNext.js server runtime内でだけ実行する。
 * Client graphへの混入はこのファイル先頭の`server-only` markerがビルド時に拒否する。
 */
let reentryGuardPromise: Promise<import('node:async_hooks').AsyncLocalStorage<true>> | undefined

async function logErrorToDatabase(
  errorType: string,
  message: string,
  stackTrace: string | null,
  context: Record<string, unknown>,
  // #2094: cause チェーン抽出用の生エラー。persist 境界で sqlState /
  // causeMessage を context へ補完するためだけに使い、message/stack の
  // 記録内容（既存の sanitize 済み値）は変えない。
  error?: unknown
): Promise<void> {
  // AsyncLocalStorageはNext.js server runtimeでのみ利用する。Client Componentから
  // このmoduleへ到達すること自体は`server-only`がcompile-timeに拒否する。
  if (process.env.NEXT_RUNTIME) {
    let guard: import('node:async_hooks').AsyncLocalStorage<true>
    try {
      if (!reentryGuardPromise) {
        reentryGuardPromise = import('node:async_hooks').then(
          ({ AsyncLocalStorage }) => new AsyncLocalStorage<true>()
        )
      }
      guard = await reentryGuardPromise
    } catch (err) {
      // M-1 (Fableレビュー): import 自体が失敗した場合のフェイルセーフ。
      // ここで reject した promise を reentryGuardPromise に残したままにすると、
      // 以後の全呼び出しが同じ rejected promise を await し続け、エラー記録
      // 機能全体が恒久的に停止してしまう（保険であるはずの再入ガードが本体の
      // 記録処理まで巻き込んで止めるのは本末転倒）。次回呼び出しで再度 import を
      // 試行できるようメモ化をリセットしたうえで、ガード無しで persist へ進む
      // （ガードが無い＝保険が効かないだけで、通常運用では #711 の不変条件により
      // そもそも再帰は起きないため実害は無い）。
      reentryGuardPromise = undefined
      console.warn(
        '[Error Tracking] Failed to load reentry guard, proceeding without it:',
        sanitizeLogArg(err),
      )
      return persistErrorToDatabase(errorType, message, stackTrace, context, error)
    }

    if (guard.getStore()) {
      // 真の再帰を検知。DBへは書き込まず console.warn のみ（この関数自身を
      // 再度呼ぶと同じ分岐を無限に辿るため、ここは再帰防止の末端でなければ
      // ならない）。
      console.warn('[Error Tracking] Reentrant error logging suppressed:', sanitizeErrorText(message))
      return
    }
    return guard.run(true, () => persistErrorToDatabase(errorType, message, stackTrace, context, error))
  }

  return persistErrorToDatabase(errorType, message, stackTrace, context, error)
}

async function persistErrorToDatabase(
  errorType: string,
  message: string,
  stackTrace: string | null,
  context: Record<string, unknown>,
  error?: unknown
): Promise<void> {
  try {
    const environment = resolveAppEnvironment()
    // #2094: DrizzleQueryError の cause（postgres.js 側の SQLSTATE と DB 側
    // メッセージ）はトップレベルの message/stack に残らないため、sqlState と
    // 最深 cause の message を context へ補完する。呼び出し元が明示的に渡した
    // 同名キーは尊重するため、補完分を先・呼び出し元の context を後に展開する。
    const contextWithCause =
      error === undefined ? context : { ...errorCauseContext(error), ...context }
    const values = {
      error_type: errorType,
      // message/context は最終書き込み境界でも再検閲する。stack は Error 境界で
      // sanitizeErrorStack() 済みで、再度 sanitizeErrorText() すると保持した実frameまで
      // `params:` 以降として消してしまうため、ここでは長さ制限だけ適用する。
      message: sanitizeErrorText(message).slice(0, MAX_MESSAGE_LENGTH),
      stack_trace: stackTrace ? stackTrace.slice(0, MAX_STACK_LENGTH) : null,
      // 機密情報（userId, token 等）を除外してから記録
      context: persistedContext(contextWithCause),
      environment,
    }

    // Next.js server runtime以外（単体テストやDB設定の無い補助CLI）から誤って
    // 呼ばれた場合は永続化しない。Client graphは実行時判定ではなく、各server-only
    // entry pointのmarkerでビルド時に遮断する。
    if (!process.env.NEXT_RUNTIME) return

    const [{ getDb }, { withDbRetry }, { errors }] = await Promise.all([
      import('@/lib/db/client'),
      import('@/lib/db/retry'),
      import('@/lib/db/schema'),
    ])
    // errors.id is generated by the database (gen_random_uuid), so a
    // connection loss can leave commit outcome unknown: the row may have
    // been inserted before the response was lost, and a blind retry can
    // then produce a duplicate row.
    //
    // #711 owner decision (issue #711 method-comparison comment, §4-3):
    // idempotent: true — accept occasional duplicate error rows in
    // exchange for surviving transient connection blips. Rationale: this
    // table holds diagnostic error logs, not product/financial data, and
    // error-reporter groups rows by (error_type, message) before opening a
    // GitHub Issue, so a duplicate is harmless noise. A silently dropped
    // error record (the failure mode of idempotent: false) is strictly
    // worse for an error-tracking pipeline than an occasional duplicate.
    await withDbRetry(async () => {
      const { db } = await getDb()
      return db.insert(errors).values(values)
    }, 'error tracking insert', { idempotent: true })
  } catch (err) {
    // エラーDBへの記録失敗はメインのエラー処理を阻害しない
    // エラー詳細を出力して Cloudflare Workers Observability (wrangler tail) で確認可能にする
    // logger.error は logErrorFromLogger() を経由してこの関数へ戻るため使用禁止。
    // console.warn を直接使うことで、この catch 自体が再帰の起点にならないことを
    // 保証する（呼び出し元の logErrorToDatabase の AsyncLocalStorage ガードと
    // 二重の防御になる）。同一isolate内の別requestで同じエラーが並行発生しても
    // 観測データを誤って捨てないことは AsyncLocalStorage ガード側で担保される
    // （上記コメント参照）。
    console.warn('[Error Tracking] Failed to persist error:', sanitizeLogArg(err))
  }
}

// Issue #401: console 経路とPlanetScale永続化経路で同一マスキングポリシーを適用するため、
// report*Error 系も console 出力前に context をサニタイズする。Cloudflare Workers logs /
// wrangler tail に raw な OAuth token 等が漏れることを防止する。
// Sanitize context for console output to enforce the same redaction policy
// across both pipelines (Cloudflare Workers logs and the PlanetScale errors table).
function consoleContext(context: Record<string, unknown> | undefined): Record<string, unknown> | string {
  if (!context) return ''
  return sanitizeContext(context)
}

export async function reportError(error: Error | unknown, context?: Record<string, unknown>) {
  const info = resolveErrorInfo(error)
  // Error インスタンスは [Error] + console.error、それ以外は [Warning] + console.warn
  const label = info.isErrorInstance ? '[Error]' : '[Warning]'
  const log = info.isErrorInstance ? console.error : console.warn
  log(label, info.message, consoleContext(context))
  await logErrorToDatabase(label, info.message, info.stack, context || {}, error)
}

export async function reportApiError(endpoint: string, method: string, error: Error | unknown, additionalContext?: Record<string, unknown>) {
  const label = `${method} ${endpoint}`
  const ctx = { endpoint, method, ...additionalContext }
  const { message, stack } = resolveErrorInfo(error)
  console.error(`[API Error] ${label}:`, message, consoleContext(additionalContext))
  await logErrorToDatabase('[API Error]', `${label}: ${message}`, stack, ctx, error)
}

export async function reportAuthError(error: Error | unknown, context: { provider?: string; action?: string; userId?: string }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Auth Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToDatabase('[Auth Error]', message, stack, context, error)
}

export async function reportGachaError(error: Error | unknown, context: { streamerId?: string; userId?: string; cost?: number }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Gacha Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToDatabase('[Gacha Error]', message, stack, context, error)
}

export async function reportRealtimeError(error: unknown, context: { action?: string; streamerId?: string; status?: string; retryCount?: number; isExpected?: boolean }) {
  // Suppress expected connection events (CLOSED, TIMED_OUT, CHANNEL_ERROR)
  // to avoid noise in logs, matching previous Sentry behavior
  // 期待されるステータスはログもDB記録もスキップ
  const EXPECTED_STATUSES = ['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR']

  if (context.isExpected || (context.status && EXPECTED_STATUSES.includes(context.status))) {
    return
  }

  const { message, stack } = resolveErrorInfo(error)
  console.error('[Realtime Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToDatabase('[Realtime Error]', message, stack, context, error)
}

export async function reportSecurityError(error: Error | unknown, context: { action?: string; userId?: string; [key: string]: unknown }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Security Error]', message, sanitizeContext(context))
  await logErrorToDatabase('[Security Error]', message, stack, context, error)
}

/**
 * server logger.error から呼ばれるPlanetScale記録専用関数。
 * console出力はlogger.server.ts側で行うため、ここではDB記録のみ。
 * args から Error と context を自動抽出する。
 */
export async function logErrorFromLogger(message: string, args: unknown[]): Promise<void> {
  try {
    let stack: string | null = null
    const context: Record<string, unknown> = {}
    let errorDetail = ''
    // #2094: message/stack の抽出元となったエラー値。errors.context への
    // sqlState / causeMessage 補完に使うため、errorDetail と同じ
    // 「最初に採用された1つ」を記録する。
    let primaryError: unknown

    for (const arg of args) {
      if (arg instanceof Error) {
        // 最初の Error を採用（原因エラーは通常先頭に渡される）
        if (!errorDetail) {
          errorDetail = sanitizeErrorText(arg.message)
          stack = arg.stack ? sanitizeErrorStack(arg.stack, arg.name, arg.message) : null
          primaryError = arg
        }
      } else if (arg && typeof arg === 'object') {
        const obj = arg as Record<string, unknown>
        // { error: ... } パターンからエラー詳細を抽出
        if ('error' in obj && obj.error != null && !errorDetail) {
          primaryError = obj.error
          if (obj.error instanceof Error) {
            errorDetail = sanitizeErrorText(obj.error.message)
            stack = obj.error.stack
              ? sanitizeErrorStack(obj.error.stack, obj.error.name, obj.error.message)
              : null
          } else {
            errorDetail = extractErrorMessage(obj.error)
          }
        } else if (!errorDetail && 'message' in obj && typeof obj.message === 'string' && obj.message !== '') {
          // error プロパティがない場合、オブジェクト自体が PostgrestError 等のエラーと判定
          // See: https://github.com/azumag/twica/issues/262
          errorDetail = sanitizeErrorText(obj.message)
          primaryError = obj
        }
        Object.assign(context, sanitizeContext(obj))
      }
    }

    const fullMessage = errorDetail ? `${message} ${errorDetail}` : message
    await logErrorToDatabase('[Error]', fullMessage, stack, context, primaryError)
  } catch {
    // エラー記録自体の失敗は、呼び出し元のメイン処理を阻害しない。
  }
}
