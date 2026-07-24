import { type NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm'
import { getSession } from '@/lib/session'

import { logger } from '@/lib/logger.server'
import { ERROR_MESSAGES } from '@/lib/constants'
import { getTosAcceptanceRow } from '@/lib/user-data'
// -----------------------------------------------------------------------------
// #711 (#570/#572 踏襲): pg 直結の書き込み経路。
// 既存 supabase-js 実装（POST の isPgWriteEnabled() 分岐より下、GET の
// getTosAcceptanceRow 経由の postgrest 実装）は 1 文字も変えずに残す
// （フラグ未設定時は完全に従来どおり動く）。getDb() は withDbRetry の queryFn 内で
// 呼ぶ規約（src/lib/db/retry.ts 参照）。
// -----------------------------------------------------------------------------
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import { users as usersTable } from '@/lib/db/schema'

/**
 * POST /api/tos/accept
 * 利用規約への同意を記録するAPI
 * Records user's acceptance of Terms of Service
 */
export async function POST(request: NextRequest) {
  // Next.js の Route Handler と直接呼び出すテストの双方で統一したシグネチャを
  // 維持する。POST 本体はセッションだけを使うため、リクエスト本文は意図的に読まない。
  void request;
  try {
    // セッションからユーザー情報を取得
    // Get user info from session
    const session = await getSession()

    if (!session) {
      // 未認証の場合は401エラーを返す
      // Return 401 if user is not authenticated
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      )
    }

    // #711: 読み取り専用ではなく users への UPDATE（書き込み）のため
    // isPgWriteEnabled() で分岐する（読み取り専用フラグ pg-read では postgrest
    // 経路のまま。ファイル冒頭のコメント・token-manager.ts の使い分け方針を参照）。
    //
    // タイムスタンプは withDbRetry の queryFn の「外」で一度だけ計算する。
    // queryFn の中で new Date() を呼ぶと、接続断などでリトライされるたびに
    // 異なる時刻が書き込まれてしまい、「同じ結果を安全に再試行できる」という
    // idempotent: true の前提（src/lib/db/retry.ts 参照）が崩れる。ここで一度だけ
    // 計算した値を使い回すことで、リトライされても常に同一の tos_accepted_at が
    // 再送される（= 何度実行しても結果が同じ）ことを保証し、idempotent: true の
    // 根拠とする。
    const acceptedAt = new Date().toISOString()

    try {
      await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
          // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
          const { db } = await getDb()
          return db
            .update(usersTable)
            .set({ tos_accepted_at: acceptedAt })
            .where(eq(usersTable.twitch_user_id, session.twitchUserId))
        },
        'tos accept update',
        { idempotent: true }
      )
    } catch (error) {
      // postgrest 経路の if (error) 分岐と同じ 500 JSON・ログメッセージを再現する
      // （エラー時のレスポンス/ログのパリティ維持がこのルートの必須要件）。
      logger.error('Failed to update TOS acceptance', {
        error: error instanceof Error ? error.message : String(error),
        twitchUserId: session.twitchUserId,
      })
      return NextResponse.json(
        { error: 'Failed to record TOS acceptance' },
        { status: 500 }
      )
    }

    // ログの acceptedAt は DB 書き込みに使った値をそのまま再利用する。
    // 直後の postgrest 経路（このファイルの下方）は書き込み用とログ用で
    // new Date().toISOString() を独立に2回呼んでおり、理論上ミリ秒単位で
    // ズレうる。この差は内部ログにのみ現れ、レスポンス JSON の形状には影響しない
    // ため、pg 経路では冪等性の根拠を明確にするためにあえて再現せず同一値を使う。
    logger.info('TOS accepted', {
      twitchUserId: session.twitchUserId,
      acceptedAt,
    })

    // 成功した場合はダッシュボードへリダイレクトするURLを返す
    // Return success with redirect URL to dashboard
    return NextResponse.json({
      success: true,
      redirectUrl: '/dashboard',
    })
  } catch (error) {
    logger.error('Error in TOS accept API', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}

/**
 * GET /api/tos/accept
 * 現在のユーザーのTOS同意状態を確認するAPI
 * Check current user's TOS acceptance status
 */
export async function GET() {
  try {
    const session = await getSession()

    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      )
    }

    // #711: users.tos_accepted_at の読み取りは user-data.ts の
    // getTosAcceptanceRow に委譲（isPgReadEnabled() による経路分岐は関数内部で
    // 行われるため、呼び出し側はフラグを意識しない。#570 パイロットと同じ方針）。
    //
    // getTosAcceptanceRow は supabase-js の { data, error } の外形に倣った
    // { row, error } を throw せず返す契約。同じクエリでも呼び出し元ごとに
    // エラー時挙動が異なるのが既存の正（この GET は error 検査 → 500、
    // tos/page.tsx は error 無視）のため、判断を呼び出し元に残す設計
    // （詳細は src/lib/user-data.ts の TosAcceptanceRowResult コメント参照）。
    // ここは既存 postgrest 実装の if (error) 分岐と同じ 500 JSON・ログメッセージを
    // 両ドライバで返す。
    const { row: user, error } = await getTosAcceptanceRow(session.twitchUserId)

    if (error) {
      logger.error('Failed to check TOS acceptance', {
        error: error.message,
        twitchUserId: session.twitchUserId,
      })
      return NextResponse.json(
        { error: 'Failed to check TOS acceptance' },
        { status: 500 }
      )
    }

    // 重要（既存実装のクセ。修正は別Issue）: user 行が存在しない場合
    // `user?.tos_accepted_at` は undefined になり、`undefined !== null` は true
    // と評価されるため、未登録ユーザーでも accepted: true が返る。バグ的挙動だが
    // Phase 1 は挙動パリティが最優先のため、pg 経路でも忠実に再現する。
    // acceptedAt も同様に undefined になり、NextResponse.json (= JSON.stringify)
    // により値が undefined のキーはレスポンス JSON から欠落する
    // （= 両経路でレスポンスのキー有無まで一致する）。
    return NextResponse.json({
      accepted: user?.tos_accepted_at !== null,
      acceptedAt: user?.tos_accepted_at,
    })
  } catch (error) {
    logger.error('Error in TOS check API', { error })
    return NextResponse.json(
      { error: ERROR_MESSAGES.INTERNAL_ERROR },
      { status: 500 }
    )
  }
}
