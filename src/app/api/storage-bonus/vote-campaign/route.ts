import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError } from '@/lib/error-handler'
import { VOTE_CAMPAIGN_CONFIG, ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'

/**
 * POST /api/storage-bonus/vote-campaign
 * 「選挙行ったよ/行こうかな」キャンペーンボーナスを適用するAPI
 *
 * 条件:
 * - ログイン済みユーザー（配信者でなくても可。将来アフィリエイトになった時に恩恵を受けられる）
 * - キャンペーン期間内のみ（サーバー時刻で判定）
 * - 1回のみ（UNIQUE制約で担保）
 * - 自己申告制（投票済証などの証拠は不要）
 * - 選挙権の有無は問わない（将来得る可能性があれば誰でもOK）
 *
 * 仕様:
 * - streamersテーブルにレコードがない場合は作成（broadcaster_type = ''）
 * - 既存レコードがある場合はそのまま使用（broadcaster_type等を上書きしない）
 * - 将来ユーザーがアフィリエイトになった時、既存レコードが更新され、ボーナスが有効になる
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

  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.UNAUTHORIZED },
      { status: 401 }
    )
  }

  // レート制限チェック（認証後にユーザーID単位で制限し、NAT環境での誤ブロックを防止）
  const identifier = await getRateLimitIdentifier(request, session.twitchUserId)
  const rateLimit = await checkRateLimit(rateLimits.voteCampaign, identifier)
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED } as ApiRateLimitResponse,
      { status: 429, headers: { 'Retry-After': String(Math.ceil(((rateLimit.reset ?? Date.now() + 60000) - Date.now()) / 1000)) } }
    )
  }

  // キャンペーン期間チェック（サーバー時刻で判定、クライアント時刻に依存しない）
  const now = new Date()
  if (now < VOTE_CAMPAIGN_CONFIG.START_DATE || now > VOTE_CAMPAIGN_CONFIG.END_DATE) {
    return NextResponse.json(
      { error: 'キャンペーン期間外です' },
      { status: 400 }
    )
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()

    // streamer_idを取得。既存レコードがあればそのまま使用し、
    // 存在しない場合のみ新規作成（既存の broadcaster_type 等を上書きしない）
    const { data: existing } = await supabaseAdmin
      .from('streamers')
      .select('id')
      .eq('twitch_user_id', session.twitchUserId)
      .maybeSingle()

    let streamerId: string
    if (existing) {
      streamerId = existing.id
    } else {
      // 将来アフィリエイトになった時のために、今のうちにレコードを作成しておく
      const { data: created, error: insertError } = await supabaseAdmin
        .from('streamers')
        .insert({
          twitch_user_id: session.twitchUserId,
          twitch_username: session.twitchUsername,
          twitch_display_name: session.twitchDisplayName,
          broadcaster_type: '',
        })
        .select('id')
        .single()

      if (insertError || !created) {
        // レースコンディション: 並行リクエストで既に作成された場合はリトライ
        if (insertError?.code === '23505') {
          const { data: retried, error: retryError } = await supabaseAdmin
            .from('streamers')
            .select('id')
            .eq('twitch_user_id', session.twitchUserId)
            .maybeSingle()
          if (retried) {
            streamerId = retried.id
          } else {
            logger.error('[ElectionCampaign] Failed to retry fetch streamer after race condition:', retryError)
            return handleApiError(insertError, 'Election Campaign API (insert streamer)')
          }
        } else {
          logger.error('[ElectionCampaign] Failed to insert streamer record:', insertError)
          return handleApiError(insertError, 'Election Campaign API (insert streamer)')
        }
      } else {
        streamerId = created.id
      }
    }

    // ボーナスを挿入（UNIQUE(streamer_id, type, memo)制約で重複適用を防止）
    const { error } = await supabaseAdmin
      .from('streamer_storage_bonus')
      .insert({
        streamer_id: streamerId,
        amount_mb: VOTE_CAMPAIGN_CONFIG.BONUS_MB,
        type: VOTE_CAMPAIGN_CONFIG.TYPE,
        memo: VOTE_CAMPAIGN_CONFIG.MEMO,
      })

    if (error) {
      // PostgreSQLのUNIQUE制約違反コード = 既に適用済み
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'このキャンペーンは既に適用済みです' },
          { status: 409 }
        )
      }
      return handleApiError(error, 'Election Campaign API')
    }

    // ユーザーIDは末尾4文字のみ表示して機密情報の漏洩リスクを軽減
    logger.info(`[ElectionCampaign] Bonus applied: twitchUserId=***${session.twitchUserId.slice(-4)}, bonusMb=${VOTE_CAMPAIGN_CONFIG.BONUS_MB}`)

    return NextResponse.json({ success: true })
  } catch (error) {
    return handleApiError(error, 'Election Campaign API')
  }
}
