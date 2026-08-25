import 'server-only'

import { NextResponse } from 'next/server'
import { logErrorFromLogger } from './sentry/error-handler'
import { sanitizeErrorText, sanitizeLogArg } from './log-sanitizer'
import { ERROR_MESSAGES } from './constants'

// Cloudflare Workers ではレスポンス返却後にバックグラウンド Promise が打ち切られるため、
// PlanetScale記録完了をawaitで確保する。logger.error（fire-and-forget）ではなく
// logErrorFromLogger を直接使用することで、記録の確実性を担保する。
//
// Issue #401: console経路とPlanetScale経路で同一の機密情報マスキングを適用するため、
// console 出力前に message / args をサニタイズする。生の error / additionalInfo がそのまま
// Cloudflare Workers logs / wrangler tail に漏れないようにする。
async function logAndRecordError(
  message: string,
  error: unknown,
  additionalInfo?: Record<string, unknown>
): Promise<void> {
  const args: unknown[] = additionalInfo ? [error, additionalInfo] : [error]
  const sanitizedMessage = sanitizeErrorText(message)
  console.error(`[ERROR] ${sanitizedMessage}`, ...args.map(sanitizeLogArg))
  await logErrorFromLogger(sanitizedMessage, args)
}

export async function handleApiError(
  error: unknown,
  context: string,
  additionalInfo?: Record<string, unknown>
): Promise<NextResponse> {
  await logAndRecordError(`${context}:`, error, additionalInfo)
  return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
}

/**
 * エラーのconsole出力とPlanetScale記録のみ行いレスポンスを返さない。
 *
 * Issue #1018: 呼び出し側がhandleApiErrorの固定500ではなく状況に応じた
 * ステータス(例: トークン恒久失効の401+requiresReauth)を返す必要がある
 * 境界で、auto-generated bug reportへの記録経路を維持するための分離。
 * レスポンス生成の責任は呼び出し側へ移るため、本関数が返すレスポンスは無い。
 */
export async function recordApiError(
  error: unknown,
  context: string,
  additionalInfo?: Record<string, unknown>
): Promise<void> {
  await logAndRecordError(`${context}:`, error, additionalInfo)
}

export async function handleDatabaseError(error: unknown, context: string): Promise<NextResponse> {
  await logAndRecordError(`${context}:`, error)
  return NextResponse.json({ error: 'Database error' }, { status: 500 })
}

const HTTP_STATUS_REASON_PHRASES = {
  401: 'unauthorized',
  503: 'service\\s+unavailable',
  507: 'insufficient\\s+storage',
} as const

// Issue #989: 裸の `503` などを部分一致させると `photo-503.png` や URL 中の数値まで
// HTTP status と誤認するため、明示的な status ラベルか標準的な status line だけを受理する。
// `httpStatusCode` は識別子途中に `status` があるため `\bstatus` 枝では一致せず、専用枝が必要。
// `503 Service Unavailable` のような数値先頭形式は理由句まで一致させ、文脈のない数値を除外する。
// r2-client のリトライ判定は一時障害メッセージを拾う目的でより広い書式を許容する一方、
// ここでは最終レスポンスの誤分類を避けるため `\D{0,10}` のような緩い範囲を意図的に使わない。
// 両者の判定器統合・入力形の整理は Issue #989 の残フォローアップとして扱う。
function hasHttpStatusContext(errorMessage: string, status: 401 | 503 | 507): boolean {
  const reasonPhrase = HTTP_STATUS_REASON_PHRASES[status]
  return new RegExp(
    `(?:\\bhttp(?:\\/[0-9.]+)?\\s+${status}\\b|\\bstatus(?:\\s*code)?\\s*[:=]?\\s*${status}\\b|\\bhttpstatuscode\\s*[:=]?\\s*${status}\\b|(?:^|[\\s:(\\[])${status}\\s+${reasonPhrase}\\b)`,
    'i'
  ).test(errorMessage)
}

export async function handleBlobError(error: unknown, context: string, additionalInfo?: Record<string, unknown>): Promise<NextResponse> {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const normalizedErrorMessage = errorMessage.toLowerCase()
  const sanitizedErrorMessage = sanitizeErrorText(errorMessage)
  await logAndRecordError(`${context}: ${sanitizedErrorMessage}`, error, additionalInfo)

  if (normalizedErrorMessage.includes('quota') || normalizedErrorMessage.includes('limit') || hasHttpStatusContext(errorMessage, 507)) {
    return NextResponse.json({ error: 'Storage quota exceeded' }, { status: 507 })
  }

  if (normalizedErrorMessage.includes('authentication') || normalizedErrorMessage.includes('unauthorized') || hasHttpStatusContext(errorMessage, 401)) {
    return NextResponse.json({ error: 'Storage authentication failed' }, { status: 503 })
  }

  if (normalizedErrorMessage.includes('service unavailable') || hasHttpStatusContext(errorMessage, 503)) {
    return NextResponse.json({ error: 'Storage service temporarily unavailable' }, { status: 503 })
  }

  return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 })
}

// Note: uploadWithRetry function was removed - R2 upload with retry is now in r2-client.ts
// 注意: uploadWithRetry関数は削除されました - R2アップロード（リトライ付き）はr2-client.tsにあります
