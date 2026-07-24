import { type NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session'

import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { validateContentType } from '@/lib/request-validation'
import { handleApiError } from '@/lib/error-handler'
import { sha256 } from '@/lib/crypto-utils'
import { ERROR_MESSAGES, PLAN_CONFIG } from '@/lib/constants'
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
interface ActivateSupportCodeRpcDriverError {
  code?: string
  message: string
}

/**
 * activate_support_code RPC (migration 00017 で新設、00018/00021 でダウングレード
 * 処理とレースコンディション修正を追加。RETURNS JSONB) の pg 直結(postgres.js)
 * 実装 (#573)。
 *
 * 全引数 TEXT のため明示キャスト不要(名前付き引数の関数解決で一意に text へ
 * 強制される。gacha.ts executeGachaTransactionRpcPg の doc コメント参照)。
 * jsonb 戻り値の JS オブジェクト化についても同 doc コメント参照。
 *
 * 既存の呼び出し側(この route)は RPC エラーを 42883 か否かで分岐せず
 * handleApiError に丸ごと渡すのみ(デプロイ窓フォールバックが元から存在しない)
 * ため、pg 経路でも 42883 特有の分岐は設けない(既存に無い保護を追加しない、
 * #573 実装規約)。
 *
 * 冪等性判断(plpgsql根拠。migration 00021「レースコンディション修正」が最新定義):
 *   -- 2. 同一コードの既存ライセンスをチェック(DELETE前に判定することでデータ消失を防止)
 *   IF EXISTS (SELECT 1 FROM user_licenses WHERE twitch_user_id = ... AND code_id = ...) THEN
 *     RETURN jsonb_build_object('error', 'ALREADY_ACTIVATED');
 *   END IF;
 *   -- 4. 新コードより上位のライセンスを削除（ダウングレード処理）
 *   DELETE FROM user_licenses ul USING support_codes sc WHERE ...;
 *   -- 5. ライセンスを挿入
 *   INSERT INTO user_licenses (...) VALUES (...) ON CONFLICT (...) DO NOTHING RETURNING id INTO v_license_id;
 *   -- 6. activation_count をインクリメント
 *   UPDATE support_codes SET activation_count = activation_count + 1, ... WHERE id = v_code_record.id;
 * この関数は (a) support_codes.activation_count のインクリメント(消費カウンタ)、
 * (b) user_licenses への一度きりの INSERT(ライセンス付与という状態遷移)、
 * (c) 新コードより上位のライセンスを DELETE するダウングレード処理、を含む。
 * 1回目の実行が実際にはコミット済みで応答だけが接続断で失われた場合、同一
 * 引数での再実行は上記(2)の既存ライセンスチェックに引っかかり早期
 * { error: 'ALREADY_ACTIVATED' } を返す(activation_count の二重加算は起きない
 * が)。これは呼び出し側で SUPPORT_CODE_ALREADY_ACTIVATED (409) にマッピング
 * されるため、実際にはコードの activation が成功しているにもかかわらず
 * ユーザーには失敗(409)したように見えてしまう。
 * 課題文が特に確認を求める「使用回数(activation_count)」「状態遷移
 * (user_licenses への一度きりの付与)」のいずれも該当するため、非冪等
 * (既定 = リトライなし)として扱う。
 */
async function activateSupportCodeRpcPg(params: {
  codeHash: string
  twitchUserId: string
  fanboxId: string | null
}): Promise<{ data: unknown; error: ActivateSupportCodeRpcDriverError | null }> {
  try {
    const data = await withDbRetry(async () => {
      // 規約: getDb() は queryFn の中で呼ぶ(src/lib/db/retry.ts 参照)
                                     const { sql } = await getDb()
      const rows = await sql<{ result: unknown }[]>`
        select activate_support_code(
          p_code_hash => ${params.codeHash},
          p_twitch_user_id => ${params.twitchUserId},
          p_fanbox_id => ${params.fanboxId}
        ) as result
      `
      return rows[0]?.result ?? null
    }, 'activate_support_code(pg)')
    // 非冪等のため withDbRetry の第3引数(idempotent オプション)は渡さない
    // (既定 false = 接続断でもリトライしない。上記コメント参照)
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
 * POST /api/support/activate
 * 支援コードをアクティベートし、ユーザーにライセンスを付与する
 *
 * フロー:
 * 1. CSRF検証
 * 2. セッション取得
 * 3. レート制限（5回/時間 - 総当り攻撃対策）
 * 4. Content-Type検証 + 入力バリデーション
 * 5. コードをSHA-256ハッシュ化
 * 6. activate_support_code RPC呼び出し（DB側で排他ロック）
 * 7. 結果に応じたレスポンス
 */
export async function POST(request: NextRequest) {
  // Content-Type検証
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) {
    return contentTypeValidation
  }

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

  // レート制限チェック（1時間5回、認証後にユーザーID単位で制限）
  const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
  const rateLimit = await checkRateLimit(rateLimits.activateCode, identifier)
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
    const body = await request.json()
    const { code, fanboxId } = body

    // 入力バリデーション
    if (!code || typeof code !== 'string' || code.trim().length === 0) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.SUPPORT_CODE_REQUIRED },
        { status: 400 }
      )
    }

    if (code.length > PLAN_CONFIG.CODE_MAX_LENGTH) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.SUPPORT_CODE_TOO_LONG },
        { status: 400 }
      )
    }

    if (fanboxId && typeof fanboxId === 'string' && fanboxId.length > PLAN_CONFIG.FANBOX_ID_MAX_LENGTH) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FANBOX_ID_TOO_LONG },
        { status: 400 }
      )
    }

    // コードをSHA-256ハッシュ化（平文をDBに送信しない）
    const codeHash = await sha256(code.trim())


    // { data, error } 正規化は activateSupportCodeRpcPg の doc コメント参照。
    const { data, error } = await activateSupportCodeRpcPg({
          codeHash,
          twitchUserId: session.twitchUserId,
          fanboxId: fanboxId?.trim() || null,
        })

    if (error) {
      return handleApiError(error, 'Support Activate API (RPC)')
    }

    // RPCの結果をチェック
    const result = data as { error?: string; success?: boolean; plan_type?: string }

    if (result.error) {
      // RPCからのエラーを適切なHTTPレスポンスにマッピング
      const errorMap: Record<string, { message: string; status: number }> = {
        INVALID_CODE: { message: ERROR_MESSAGES.INVALID_SUPPORT_CODE, status: 404 },
        CODE_REVOKED: { message: ERROR_MESSAGES.SUPPORT_CODE_REVOKED, status: 410 },
        CODE_ROTATING: { message: ERROR_MESSAGES.SUPPORT_CODE_ROTATING, status: 410 },
        ALREADY_ACTIVATED: { message: ERROR_MESSAGES.SUPPORT_CODE_ALREADY_ACTIVATED, status: 409 },
      }

      const mapped = errorMap[result.error]
      if (mapped) {
        return NextResponse.json(
          { error: mapped.message },
          { status: mapped.status }
        )
      }

      // 未知のエラー
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNEXPECTED_ERROR },
        { status: 500 }
      )
    }

    // RPCが上位ライセンスの削除を含めてアトミックに処理済みのため、
    // result.plan_type が実効プランと一致する（余分なDB呼び出し不要）
    logger.info(`[SupportActivate] Code activated: twitchUserId=***${session.twitchUserId.slice(-4)}, planType=${result.plan_type}`)

    return NextResponse.json({
      success: true,
      planType: result.plan_type,
    })
  } catch (error) {
    return handleApiError(error, 'Support Activate API')
  }
}
