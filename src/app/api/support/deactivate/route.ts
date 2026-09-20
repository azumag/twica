import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session'

import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError } from '@/lib/error-handler'
import { ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger.server'
import type { ApiRateLimitResponse } from '@/types/api'
// ---------------------------------------------------------------------------
// import が存在するだけでは挙動に影響しない(#570 の設計。tests/setup.ts の
// ---------------------------------------------------------------------------
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'

/**
 * 「code + message」形状へ正規化するための最小型(#573)。postgres.js は
 * (handleApiError への受け渡し)を両経路で共有するにはこの形への詰め替えが必要
 * (gacha.ts GachaRpcDriverError と同じ設計)。
 */
interface DeactivateAllLicensesRpcDriverError {
  code?: string
  message: string
}

/**
 * deactivate_all_licenses RPC (migration 00018、RETURNS JSONB) の pg 直結
 * (postgres.js) 実装 (#573)。
 *
 * p_twitch_user_id は TEXT のため明示キャスト不要(名前付き引数の関数解決で
 * 一意に text へ強制される。gacha.ts executeGachaTransactionRpcPg の doc
 * コメント参照)。jsonb 戻り値の JS オブジェクト化についても同 doc コメント参照。
 *
 * 既存の呼び出し側(この route)は RPC エラーを 42883 か否かで分岐せず
 * handleApiError に丸ごと渡すのみ(デプロイ窓フォールバックが元から存在しない)
 * ため、pg 経路でも 42883 特有の分岐は設けない(既存に無い保護を追加しない、
 * #573 実装規約)。
 *
 * 冪等性判断(plpgsql根拠):
 *   DELETE FROM user_licenses WHERE twitch_user_id = p_twitch_user_id;
 *   GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
 *   RETURN jsonb_build_object('success', true, 'deleted_count', v_deleted_count);
 * 「このユーザーの全ライセンスを削除する」という非ユニークキー条件の DELETE で、
 * 1回目の実行後は対象ユーザーのライセンスが0件に収束する。2回目以降の実行は
 * 0件 DELETE (deleted_count:0) になるだけでエラーにはならず、「ライセンスが
 * 存在しない」という最終状態は1回目・2回目とも同じ(migration 00018 のコメント
 * 自体が「冪等性あり: ライセンスがない場合もエラーにならない」と明記)。この
 * route のレスポンスは deleted_count の値を一切外部に返さず(ログにのみ使用。
 * 常に `{ success: true, planType: 'basic' }` を返す)、再実行で deleted_count が
 * 0 と N のどちらであっても呼び出し元から見た外部挙動は完全に同一。
 * storage-db.ts removeBlobFilePg の「PK指定のDELETEは再実行しても最終状態が
 * 同じため冪等」という判断と同種であり、こちらは非ユニークキー(twitch_user_id)
 * 指定だが同じ「削除は空集合に収束する」性質を持つ。
 * よって idempotent: true として接続断リトライを許可する。
 */
async function deactivateAllLicensesRpcPg(
  twitchUserId: string
): Promise<{ data: unknown; error: DeactivateAllLicensesRpcDriverError | null }> {
  try {
    const data = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ(src/lib/db/retry.ts 参照)
        const { sql } = await getDb()
        const rows = await sql<{ result: unknown }[]>`
          select deactivate_all_licenses(
            p_twitch_user_id => ${twitchUserId}
          ) as result
        `
        return rows[0]?.result ?? null
      },
      'deactivate_all_licenses(pg)',
      { idempotent: true },
    )
    return { data, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = (error as { code?: unknown } | null)?.code
    return {
      data: null,
      error: { code: typeof code === 'string' ? code : undefined, message },
    }
  }
}

/**
 * POST /api/support/deactivate
 * 全ライセンスを削除し、Basicプランに復帰する
 *
 * activate/route.ts と同一パターン（CSRF/セッション/レート制限）
 * deactivate_all_licenses RPC は冪等なので、Basic時に実行してもエラーにならない
 * リクエストボディは不要（ユーザーIDはセッションから取得）のためContent-Type検証は省略
 */
export async function POST(request: NextRequest) {
  // CSRF検証
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  // セッション取得
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.UNAUTHORIZED },
      { status: 401 }
    )
  }

  // レート制限チェック（activateとは独立した制限枠を使用）
  const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
  const rateLimit = await checkRateLimit(rateLimits.deactivatePlan, identifier)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 3600000) - Date.now()) / 1000))
        }
      }
    )
  }

  try {

    // { data, error } 正規化は deactivateAllLicensesRpcPg の doc コメント参照。
    const { data, error } = await deactivateAllLicensesRpcPg(session.twitchUserId)

    if (error) {
      return handleApiError(error, 'Support Deactivate API (RPC)')
    }

    const result = data as { success?: boolean; deleted_count?: number }

    logger.info(`[SupportDeactivate] Licenses deactivated: twitchUserId=***${session.twitchUserId.slice(-4)}, deletedCount=${result.deleted_count}`)

    return NextResponse.json({
      success: true,
      planType: 'basic',
    })
  } catch (error) {
    return handleApiError(error, 'Support Deactivate API')
  }
}
