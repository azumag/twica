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
 * - sanitizeContext / extractErrorMessage は log-sanitizer.ts に集約
 * - 同じユーティリティを logger.ts も使用しており、console 経路 / DB 記録経路で
 *   同一ポリシーが適用される（Issue #401）
 * - Sensitive-info masking lives in log-sanitizer so both the console pipeline
 *   (logger) and the database pipeline use the same redaction policy.
 */

import { sanitizeContext, extractErrorMessage } from '@/lib/log-sanitizer'
import type { Json } from '@/types/database'

/**
 * error から message と stack を統一的に解決する。
 * 全 report*Error 関数の if/else 分岐を集約し DRY 原則を維持する。
 */
function resolveErrorInfo(error: unknown): { message: string; stack: string | null; isErrorInstance: boolean } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack || null, isErrorInstance: true }
  }
  return { message: extractErrorMessage(error), stack: null, isErrorInstance: false }
}

// PostgreSQL TEXT 型は最大1GBだが、実用的な上限として定数化
const MAX_MESSAGE_LENGTH = 10000
const MAX_STACK_LENGTH = 50000

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
  context: Record<string, unknown>
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
      console.warn('[Error Tracking] Failed to load reentry guard, proceeding without it:', err)
      return persistErrorToDatabase(errorType, message, stackTrace, context)
    }

    if (guard.getStore()) {
      // 真の再帰を検知。DBへは書き込まず console.warn のみ（この関数自身を
      // 再度呼ぶと同じ分岐を無限に辿るため、ここは再帰防止の末端でなければ
      // ならない）。
      console.warn('[Error Tracking] Reentrant error logging suppressed:', message)
      return
    }
    return guard.run(true, () => persistErrorToDatabase(errorType, message, stackTrace, context))
  }

  return persistErrorToDatabase(errorType, message, stackTrace, context)
}

async function persistErrorToDatabase(
  errorType: string,
  message: string,
  stackTrace: string | null,
  context: Record<string, unknown>
): Promise<void> {
  try {
    // 環境判定: NEXT_PUBLIC_APP_URL に 'preview' が含まれるかで判定
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    const environment = appUrl.includes('preview') ? 'preview' : 'production'
    const values = {
      error_type: errorType,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      stack_trace: stackTrace?.slice(0, MAX_STACK_LENGTH) || null,
      // 機密情報（userId, token 等）を除外してから記録
      context: persistedContext(context),
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
    console.warn('[Error Tracking] Failed to persist error:', err)
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
  await logErrorToDatabase(label, info.message, info.stack, context || {})
}

export async function reportApiError(endpoint: string, method: string, error: Error | unknown, additionalContext?: Record<string, unknown>) {
  const label = `${method} ${endpoint}`
  const ctx = { endpoint, method, ...additionalContext }
  const { message, stack } = resolveErrorInfo(error)
  console.error(`[API Error] ${label}:`, message, consoleContext(additionalContext))
  await logErrorToDatabase('[API Error]', `${label}: ${message}`, stack, ctx)
}

export async function reportAuthError(error: Error | unknown, context: { provider?: string; action?: string; userId?: string }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Auth Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToDatabase('[Auth Error]', message, stack, context)
}

export async function reportGachaError(error: Error | unknown, context: { streamerId?: string; userId?: string; cost?: number }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Gacha Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToDatabase('[Gacha Error]', message, stack, context)
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
  await logErrorToDatabase('[Realtime Error]', message, stack, context)
}

export async function reportSecurityError(error: Error | unknown, context: { action?: string; userId?: string; [key: string]: unknown }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Security Error]', message, sanitizeContext(context))
  await logErrorToDatabase('[Security Error]', message, stack, context)
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

    for (const arg of args) {
      if (arg instanceof Error) {
        // 最初の Error を採用（原因エラーは通常先頭に渡される）
        if (!errorDetail) {
          errorDetail = arg.message
          stack = arg.stack || null
        }
      } else if (arg && typeof arg === 'object') {
        const obj = arg as Record<string, unknown>
        // { error: ... } パターンからエラー詳細を抽出
        if ('error' in obj && obj.error != null && !errorDetail) {
          if (obj.error instanceof Error) {
            errorDetail = (obj.error as Error).message
            stack = (obj.error as Error).stack || null
          } else {
            errorDetail = extractErrorMessage(obj.error)
          }
        } else if (!errorDetail && 'message' in obj && typeof obj.message === 'string' && obj.message !== '') {
          // error プロパティがない場合、オブジェクト自体が PostgrestError 等のエラーと判定
          // See: https://github.com/azumag/twica/issues/262
          errorDetail = obj.message
        }
        Object.assign(context, obj)
      }
    }

    const fullMessage = errorDetail ? `${message} ${errorDetail}` : message
    await logErrorToDatabase('[Error]', fullMessage, stack, context)
  } catch {
    // エラー記録自体の失敗は、呼び出し元のメイン処理を阻害しない。
  }
}
