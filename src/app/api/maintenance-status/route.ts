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
 * Cache-Control: public, max-age=5, stale-while-revalidate=60 の理由:
 * Issue #906 で Workers Cache を有効化し、高頻度ポーリング（60秒間隔）の CPU コストを
 * 削減する。HIT 時は Worker が実行されず CPU 課金ゼロになる。
 * - max-age=5: クライアントのポーリング間隔（60秒）より十分短い。
 * - stale-while-revalidate=60: SWR 中は stale を即返しつつバックグラウンドで再検証する。
 *   クライアントが受け取るデータは最悪で max-age + SWR 分（≈65秒）古くなりうる。
 *   メンテバナーの表示遅延は最大でポーリング2周期分（≈120秒）に達しうるが、
 *   書き込みガードは middleware の guard.ts が env を直接読むため、この API の
 *   キャッシュ遅延に影響されない（バナー表示のみの遅延で、安全に許容できる）。
 * このエンドポイントは機密情報を返さずセッション非依存のため、公開キャッシュに安全。
 * キャッシュ HIT 時は middleware のグローバルレートリミットもスキップされるが、
 * 公開エンドポイントで実害はない。
 */
export async function GET() {
  const { mode, expectedEndAt, publicMessageKey } = getMaintenanceState()

  const body: MaintenanceStatusResponse = {
    mode,
    ...(expectedEndAt ? { expectedEndAt } : {}),
    ...(publicMessageKey ? { publicMessageKey } : {}),
  }

  const response = NextResponse.json(body)
  response.headers.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=60')
  return response
}
