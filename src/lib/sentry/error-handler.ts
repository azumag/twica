/**
 * Error Reporting Abstraction Layer
 * エラーレポート抽象レイヤー
 *
 * Sentry SDK was removed to reduce bundle size for Cloudflare Workers deployment
 * (Sentry was duplicated 4x by Turbopack, consuming ~16.8MB of the 23MB bundle).
 * This layer is maintained as an abstraction so that error monitoring can be
 * re-enabled by changing only the implementation in this file.
 *
 * 現在の実装: console.error + Supabase errors テーブルへの記録
 * Supabase に記録されたエラーは Cron Worker (twica-error-reporter) が
 * 定期的に読み出して GitHub Issue を自動作成する。
 *
 * See: https://github.com/azumag/twica/issues/235 (Sentry削除)
 * See: https://github.com/azumag/twica/issues/239 (エラー監視再導入)
 */

/**
 * Supabase errors テーブルへの記録方針:
 * - サーバーサイド (Cloudflare Workers) でのみ動作
 * - クライアントサイドでは getSupabaseAdmin() が失敗するため無視される
 * - Supabase への記録失敗はメインのエラー処理を阻害しない
 * - fetch() の I/O wait は Workers の CPU 時間 (10ms) にカウントされない
 *
 * dynamic import する理由:
 * - error-handler.ts はクライアント・サーバー両方からインポートされる
 * - サーバーサイドでのみ Supabase クライアントをロードする
 *
 * 機密情報マスキング:
 * - sanitizeContext / extractErrorMessage は log-sanitizer.ts に集約
 * - 同じユーティリティを logger.ts も使用しており、console 経路 / Supabase 経路で
 *   同一ポリシーが適用される（Issue #401）
 * - Sensitive-info masking lives in log-sanitizer so both the console pipeline
 *   (logger) and the Supabase pipeline use the same redaction policy.
 */

import { sanitizeContext, extractErrorMessage } from '@/lib/log-sanitizer'
// #663: pg 直結経路の context (jsonb) 列型に合わせるための型 import（型のみの
// import はクライアントバンドルに含まれないため静的で安全。実装モジュール
// （db/client 等）は既存の supabase/admin と同様に dynamic import する）
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

/**
 * errors テーブルへの記録の pg 直結実装 (#663)
 *
 * 【最重要】この関数はエラー報告経路であり、ここで throw が呼び出し元まで漏れると
 * 「エラー記録の失敗」が「本来のリクエスト処理の失敗」という二次障害に化ける。
 * 必ず logErrorToSupabase の try ブロックの中から await され、失敗はすべて既存の
 * catch（console.warn のみ）で握り潰される構造を維持すること。この関数自体は
 * throw してよい（呼び出し元の catch が既存実装と同一の握り潰し挙動を保証する）。
 *
 * PostgREST 実装との対応:
 * - INSERT の列・切り詰め・sanitizeContext・environment 判定は既存実装と同一。
 * - 既知の挙動差（ログ 1 行のみ）: 既存経路は insert の { error } を確認しない
 *   ため INSERT 失敗が完全に無音だが、pg 経路は失敗が throw になり呼び出し元
 *   catch の console.warn に到達する（getSupabaseAdmin() が throw するケースと
 *   同じ経路）。呼び出し元へ throw が漏れない点は同一で、切替検証にも有用な差
 *   のため許容する。
 * - context は jsonb 列（schema.ts で $type<Json>）。sanitizeContext の戻り値
 *   （Record<string, unknown>）は PostgREST 経路もそのまま JSON 化して送って
 *   おり、値の変換をしないキャストのみ行う。
 *
 * ON CONFLICT の無い INSERT はリトライで二重記録（GitHub Issue の重複作成）に
 * なりうるため非冪等（既定 = リトライなし）。withDbRetry で包むのは失敗時の
 * [db:pg] タグ付き warn（監視手順）のため。
 * なお withDbRetry の失敗ログは logger.warn（console 出力のみ）であり、
 * logger.error → logErrorFromLogger → 本関数 の再帰は発生しない。
 */
async function logErrorToPgErrors(
  errorType: string,
  message: string,
  stackTrace: string | null,
  context: Record<string, unknown>
): Promise<void> {
  const { getDb } = await import('@/lib/db/client')
  const { withDbRetry } = await import('@/lib/db/retry')
  const { errors: errorsTable } = await import('@/lib/db/schema')

  // 環境判定: NEXT_PUBLIC_APP_URL に 'preview' が含まれるかで判定（既存と同一）
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
  const environment = appUrl.includes('preview') ? 'preview' : 'production'

  await withDbRetry(
    async () => {
      // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
      const { db } = await getDb()
      return db.insert(errorsTable).values({
        error_type: errorType,
        message: message.slice(0, MAX_MESSAGE_LENGTH),
        stack_trace: stackTrace?.slice(0, MAX_STACK_LENGTH) || null,
        // 機密情報（userId, token 等）を除外してから記録
        context: sanitizeContext(context) as Json,
        environment,
      })
    },
    'logErrorToSupabase(insert errors)',
  )
}

async function logErrorToSupabase(
  errorType: string,
  message: string,
  stackTrace: string | null,
  context: Record<string, unknown>
): Promise<void> {
  // Client bundles import this module through logger/realtime code, but the
  // Supabase error table requires server-only service-role credentials.
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'test') {
    return
  }

  try {
    // #663: errors への INSERT（書き込み）を含むため isPgWriteEnabled() で分岐。
    // フラグ判定・pg 経路の失敗もすべてこの try の catch（console.warn のみ）で
    // 握り潰され、エラー報告経路から呼び出し元へ throw が漏れることはない
    // （既存実装と同一の安全性）。フラグ未設定時（既定 'postgrest'）は素通りし、
    // 以下の既存実装が従来どおり動く。
    const { isPgWriteEnabled } = await import('@/lib/db/flags')
    if (isPgWriteEnabled()) {
      await logErrorToPgErrors(errorType, message, stackTrace, context)
      return
    }

    const { getSupabaseAdmin } = await import('@/lib/supabase/admin')
    const supabase = getSupabaseAdmin()

    // 環境判定: NEXT_PUBLIC_APP_URL に 'preview' が含まれるかで判定
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    const environment = appUrl.includes('preview') ? 'preview' : 'production'

    await supabase.from('errors').insert({
      error_type: errorType,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      stack_trace: stackTrace?.slice(0, MAX_STACK_LENGTH) || null,
      // 機密情報（userId, token 等）を除外してから記録
      context: sanitizeContext(context),
      environment,
    })
  } catch (err) {
    // Supabase への記録失敗はメインのエラー処理を阻害しない
    // エラー詳細を出力して Cloudflare Workers Observability (wrangler tail) で確認可能にする
    console.warn('[Error Tracking] Failed to log error to Supabase:', err)
  }
}

// Issue #401: console 経路と Supabase 経路で同一マスキングポリシーを適用するため、
// report*Error 系も console 出力前に context をサニタイズする。Cloudflare Workers logs /
// wrangler tail に raw な OAuth token 等が漏れることを防止する。
// Sanitize context for console output to enforce the same redaction policy
// across both pipelines (Cloudflare Workers logs and Supabase errors table).
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
  await logErrorToSupabase(label, info.message, info.stack, context || {})
}

export async function reportApiError(endpoint: string, method: string, error: Error | unknown, additionalContext?: Record<string, unknown>) {
  const label = `${method} ${endpoint}`
  const ctx = { endpoint, method, ...additionalContext }
  const { message, stack } = resolveErrorInfo(error)
  console.error(`[API Error] ${label}:`, message, consoleContext(additionalContext))
  await logErrorToSupabase('[API Error]', `${label}: ${message}`, stack, ctx)
}

export async function reportAuthError(error: Error | unknown, context: { provider?: string; action?: string; userId?: string }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Auth Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToSupabase('[Auth Error]', message, stack, context)
}

export async function reportGachaError(error: Error | unknown, context: { streamerId?: string; userId?: string; cost?: number }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Gacha Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToSupabase('[Gacha Error]', message, stack, context)
}

export async function reportBattleError(error: Error | unknown, context: { battleId?: string; userId?: string; round?: number }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Battle Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToSupabase('[Battle Error]', message, stack, context)
}

export async function reportRealtimeError(error: unknown, context: { action?: string; streamerId?: string; status?: string; retryCount?: number; isExpected?: boolean }) {
  // Suppress expected connection events (CLOSED, TIMED_OUT, CHANNEL_ERROR)
  // to avoid noise in logs, matching previous Sentry behavior
  // 期待されるステータスはログもSupabase記録もスキップ
  const EXPECTED_STATUSES = ['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR']

  if (context.isExpected || (context.status && EXPECTED_STATUSES.includes(context.status))) {
    return
  }

  const { message, stack } = resolveErrorInfo(error)
  console.error('[Realtime Error]', message, sanitizeContext(context as Record<string, unknown>))
  await logErrorToSupabase('[Realtime Error]', message, stack, context)
}

export async function reportSecurityError(error: Error | unknown, context: { action?: string; userId?: string; [key: string]: unknown }) {
  const { message, stack } = resolveErrorInfo(error)
  console.error('[Security Error]', message, sanitizeContext(context))
  await logErrorToSupabase('[Security Error]', message, stack, context)
}

/**
 * logger.error から呼ばれる Supabase 記録専用関数。
 * console 出力は logger.error 側で行うため、ここでは Supabase 記録のみ。
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
    await logErrorToSupabase('[Error]', fullMessage, stack, context)
  } catch {
    // Supabase 報告失敗はメイン処理を阻害しない
  }
}
