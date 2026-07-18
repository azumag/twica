import { NextResponse } from 'next/server'
import { getMaintenanceState } from '@/lib/maintenance/state'
import type { MaintenanceStatusResponse } from '@/lib/maintenance/client'

/**
 * GET /api/maintenance-status (#694 Stage 6a)
 *
 * UI が maintenance 状態を検出するための public status endpoint。
 * 未認証で呼べる（issue #694 の要求: ログイン画面自体がメンテ中でも状態を
 * 表示できる必要があるため、認証を要求しない）。
 *
 * 機密情報を返さない設計:
 * getMaintenanceState() は startedAt / operationId も含む内部運用向けの
 * 完全な状態を返すが、このレスポンスには mode / expectedEndAt /
 * publicMessageKey の3フィールドのみを含める。startedAt（メンテ頻度等の
 * 運用パターンの推測材料になりうる）と operationId（インシデント対応の
 * 内部相関ID）は、issue #694 の「public status endpoint に機密情報を
 * 出さない」という要求に従い、意図的に除外する。レスポンス形状の単一の
 * 定義元は src/lib/maintenance/client.ts の MaintenanceStatusResponse
 * （クライアント側の fetchMaintenanceStatus と型を共有し、乖離を防ぐ）。
 *
 * GETのみ・DB接続なし・認証なしの軽量な実装:
 * - DB接続を一切作らない（getMaintenanceState は環境変数の読み取りのみ）。
 * - rate limit は個別に持たず、src/middleware.ts の global rate limit
 *   （全 /api ルート共通）に委ねる。
 * - このルートは POST/PUT/PATCH/DELETE を export しないため、
 *   config/maintenance-write-surfaces.json への登録は不要
 *   （scripts/check-maintenance-surfaces.js は書き込みメソッドのみを
 *   棚卸し対象にする設計。src/middleware.ts の MAINTENANCE_GUARDED_METHODS
 *   と同じ4メソッドのみが対象で、GET専用ルートはスコープ外）。
 *
 * Cache-Control: private, no-store の理由:
 * CDN/ブラウザがこの応答をキャッシュすると、メンテナンス解除後も
 * しばらく古い mode を返し続けてしまう（バナーが消えない・逆に解除直後の
 * 古い 'off' 応答がキャッシュされて新たなメンテ開始が伝わらない、の両方が
 * 起こりうる）。状態が変わるたびに必ず最新値を返す必要があるため、
 * 常にキャッシュを禁止する。
 */
export async function GET() {
  const { mode, expectedEndAt, publicMessageKey } = getMaintenanceState()

  const body: MaintenanceStatusResponse = {
    mode,
    ...(expectedEndAt ? { expectedEndAt } : {}),
    ...(publicMessageKey ? { publicMessageKey } : {}),
  }

  const response = NextResponse.json(body)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
