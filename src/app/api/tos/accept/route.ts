import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { ERROR_MESSAGES } from '@/lib/constants'
// -----------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。
// POST（users への UPDATE = 書き込み）は isPgWriteEnabled()、GET（読み取り専用）は
// isPgReadEnabled() で分岐する（フラグ使い分けは sub-check.ts 冒頭コメント参照）。
// 既存 supabase-js 実装は 1 文字も変えず、フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled, isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { users as usersTable } from '@/lib/db/schema'

/**
 * POST の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - users への UPDATE は .select() を伴わないため、既存実装では 0 行更新
 *   （ユーザー不在）でもエラーにならず成功レスポンスになる。pg 版も
 *   .returning() を付けず、0 行更新をエラー扱いしない（同じ外部挙動）。
 * - 失敗時は既存の error 分岐と同じログ（error はメッセージ文字列）+ 500、
 *   成功時は同一の logger.info + { success, redirectUrl } を返す。
 *
 * tos_accepted_at の値は queryFn の外で 1 度だけ計算するため、リトライしても
 * 同じ値を書く UPDATE（= 冪等）となり idempotent: true でリトライを opt-in できる。
 */
async function acceptTosPg(twitchUserId: string): Promise<NextResponse> {
  const acceptedAtIso = new Date().toISOString()
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .update(usersTable)
          .set({ tos_accepted_at: acceptedAtIso })
          .where(eq(usersTable.twitch_user_id, twitchUserId))
      },
      'tosAccept(update)',
      { idempotent: true },
    )
  } catch (error) {
    logger.error('Failed to update TOS acceptance', {
      error: error instanceof Error ? error.message : String(error),
      twitchUserId,
    })
    return NextResponse.json(
      { error: 'Failed to record TOS acceptance' },
      { status: 500 }
    )
  }

  logger.info('TOS accepted', {
    twitchUserId,
    acceptedAt: new Date().toISOString(),
  })

  return NextResponse.json({
    success: true,
    redirectUrl: '/dashboard',
  })
}

/**
 * GET の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - .maybeSingle() は users.twitch_user_id の UNIQUE 制約（migration 00001）に
 *   より最大 1 行のため、LIMIT 1 + rows[0] ?? null が同じ外部挙動。
 * - ユーザー不在（user = null）時は既存実装と同じく
 *   `user?.tos_accepted_at !== null` = `undefined !== null` = true、
 *   acceptedAt は undefined（JSON からキーごと欠落）になる（挙動を変えない）。
 * - 失敗時は既存の error 分岐と同じログ + 500。
 *
 * 日付の既知の表現差: acceptedAt は pg 直結だと PG テキスト形式
 * （'2026-03-10 12:00:00.123456+00'）、PostgREST は ISO 8601 を返す。この GET の
 * レスポンスを消費するクライアントは現状存在せず（src 内の /api/tos/accept 利用は
 * TosAcceptButton の POST のみ）、文字列を直接表示・パースする消費側がないため
 * 生文字列のまま返す（dashboard-data.ts と同じ方針。消費側を追加する場合は
 * new Date(x).toISOString() 正規化を検討すること）。
 */
async function checkTosPg(twitchUserId: string): Promise<NextResponse> {
  let user: { tos_accepted_at: string | null } | null
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({ tos_accepted_at: usersTable.tos_accepted_at })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'tosAccept(check)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    user = rows[0] ?? null
  } catch (error) {
    logger.error('Failed to check TOS acceptance', {
      error: error instanceof Error ? error.message : String(error),
      twitchUserId,
    })
    return NextResponse.json(
      { error: 'Failed to check TOS acceptance' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    accepted: user?.tos_accepted_at !== null,
    acceptedAt: user?.tos_accepted_at,
  })
}

/**
 * POST /api/tos/accept
 * 利用規約への同意を記録するAPI
 * Records user's acceptance of Terms of Service
 */
export async function POST(request: NextRequest) {
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

    // #663: 書き込み（UPDATE）を含むため isPgWriteEnabled() で分岐。
    // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
    if (isPgWriteEnabled()) {
      return acceptTosPg(session.twitchUserId)
    }

    const supabaseAdmin = getSupabaseAdmin()

    // 利用規約同意日時を更新
    // Update TOS acceptance timestamp
    const { error } = await supabaseAdmin
      .from('users')
      .update({
        tos_accepted_at: new Date().toISOString(),
      })
      .eq('twitch_user_id', session.twitchUserId)

    if (error) {
      logger.error('Failed to update TOS acceptance', {
        error: error.message,
        twitchUserId: session.twitchUserId,
      })
      return NextResponse.json(
        { error: 'Failed to record TOS acceptance' },
        { status: 500 }
      )
    }

    logger.info('TOS accepted', {
      twitchUserId: session.twitchUserId,
      acceptedAt: new Date().toISOString(),
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

    // #663: 読み取り専用のため isPgReadEnabled() で分岐。
    if (isPgReadEnabled()) {
      return checkTosPg(session.twitchUserId)
    }

    const supabaseAdmin = getSupabaseAdmin()

    // ユーザーのTOS同意状態を取得
    // Get user's TOS acceptance status
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('tos_accepted_at')
      .eq('twitch_user_id', session.twitchUserId)
      .maybeSingle()

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
