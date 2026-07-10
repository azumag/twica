import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError } from '@/lib/error-handler'
import { VOTE_CAMPAIGN_CONFIG, ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'
// -----------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。
// streamers の読み取り + streamers / streamer_storage_bonus への INSERT が混在する
// 処理のため、isPgWriteEnabled() で DB アクセス全体を分岐する（sub-check.ts 冒頭の
// フラグ使い分け方針と同じ）。既存 supabase-js 実装は 1 文字も変えず、
// フラグ未設定時は完全に従来どおり動く。
// -----------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import {
  streamers as streamersTable,
  streamerStorageBonus as streamerStorageBonusTable,
} from '@/lib/db/schema'

/**
 * キャンペーンボーナス適用の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - streamers の .maybeSingle() は twitch_user_id の UNIQUE 制約（migration 00001）
 *   により最大 1 行のため、LIMIT 1 + rows[0] ?? null が同じ外部挙動。
 *   既存実装は select の error を確認しない（data のみ分割代入）ため、取得失敗時は
 *   existing = null として INSERT へ進む。pg 版も catch で null に落として同じ流れに
 *   する（INSERT が 23505 なら再取得で回復、それ以外はそこでエラーレスポンス。
 *   失敗自体は withDbRetry の [db:pg] warn ログで観測可能）。
 * - streamers INSERT の .select('id').single() は .returning({ id }) で形状を
 *   合わせる。23505（UNIQUE 違反 = 並行リクエストとのレース）はエラーの code
 *   （postgres.js は SQLSTATE を err.code に持つ）で判定し、既存と同じ再取得
 *   フローに入る。それ以外の失敗は handleApiError（同一 context 文字列）で 500。
 * - streamer_storage_bonus INSERT の 23505（UNIQUE(streamer_id, type, memo)、
 *   migration 00013）は「適用済み」の 409、それ以外は handleApiError で 500
 *   （HTTP レスポンスのパリティ）。
 */
async function applyVoteCampaignBonusPg(session: {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
}): Promise<NextResponse> {
  try {
    // streamer_idを取得。既存レコードがあればそのまま使用し、
    // 存在しない場合のみ新規作成（既存レコードを上書きしない）
    let existing: { id: string } | null
    try {
      const rows = await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
          // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
          const { db } = await getDb()
          return db
            .select({ id: streamersTable.id })
            .from(streamersTable)
            .where(eq(streamersTable.twitch_user_id, session.twitchUserId))
            .limit(1)
        },
        'voteCampaign(streamer)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true },
      )
      existing = rows[0] ?? null
    } catch {
      // 既存実装は select エラーを握り潰して INSERT へ進む（上記コメント参照）
      existing = null
    }

    let streamerId: string
    if (existing) {
      streamerId = existing.id
    } else {
      // 将来アフィリエイトになった時のために、今のうちにレコードを作成しておく
      // （意図の詳細は下の既存 postgrest 実装のコメント参照）
      let createdId: string | null = null
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb()
            return db
              .insert(streamersTable)
              .values({
                twitch_user_id: session.twitchUserId,
                twitch_username: session.twitchUsername,
                twitch_display_name: session.twitchDisplayName,
              })
              .returning({ id: streamersTable.id })
          },
          'voteCampaign(insert streamer)',
          // ON CONFLICT の無い INSERT は再実行で UNIQUE 違反になりうるため
          // 非冪等（既定 = リトライなし）
        )
        createdId = rows[0]?.id ?? null
      } catch (insertError) {
        // レースコンディション: 並行リクエストで既に作成された場合はリトライ
        if ((insertError as { code?: unknown })?.code === '23505') {
          let retried: { id: string } | null = null
          let retryError: unknown = null
          try {
            const rows = await withDbRetry(
              async () => {
                const { db } = await getDb()
                return db
                  .select({ id: streamersTable.id })
                  .from(streamersTable)
                  .where(eq(streamersTable.twitch_user_id, session.twitchUserId))
                  .limit(1)
              },
              'voteCampaign(retry streamer)',
              // 読み取り専用クエリのため冪等（リトライ可）
              { idempotent: true },
            )
            retried = rows[0] ?? null
          } catch (error) {
            retryError = error
          }
          if (retried) {
            // レース回復: 並行リクエストが作成済みのレコードをそのまま使う
            createdId = retried.id
          } else {
            // 既存実装の handleApiError(retryError ?? insertError, ...) と同じ:
            // 再取得が throw したらそのエラー、0 行なら元の insertError を渡す
            return handleApiError(retryError ?? insertError, 'Election Campaign API (retry fetch streamer after race condition)')
          }
        } else {
          return handleApiError(insertError, 'Election Campaign API (insert streamer)')
        }
      }
      if (!createdId) {
        // INSERT ... RETURNING は成功時必ず 1 行返すため実際には到達しない防御的
        // 分岐（既存 .single() の 0 行エラー = handleApiError と同じ外部挙動に倒す）
        return handleApiError(new Error('insert streamers returned no rows'), 'Election Campaign API (insert streamer)')
      }
      streamerId = createdId
    }

    return insertVoteCampaignBonusPg(streamerId, session.twitchUserId)
  } catch (error) {
    return handleApiError(error, 'Election Campaign API')
  }
}

/**
 * ボーナス INSERT + 成功レスポンス（applyVoteCampaignBonusPg の下請け。
 * streamer 既存/新規作成/レース回復の 3 経路すべてが同じ後続処理に合流するため分離）
 */
async function insertVoteCampaignBonusPg(
  streamerId: string,
  twitchUserId: string
): Promise<NextResponse> {
  // ボーナスを挿入（UNIQUE(streamer_id, type, memo)制約で重複適用を防止）
  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db.insert(streamerStorageBonusTable).values({
          streamer_id: streamerId,
          amount_mb: VOTE_CAMPAIGN_CONFIG.BONUS_MB,
          type: VOTE_CAMPAIGN_CONFIG.TYPE,
          memo: VOTE_CAMPAIGN_CONFIG.MEMO,
        })
      },
      'voteCampaign(insert bonus)',
      // ON CONFLICT の無い INSERT。リトライすると「1 回目が COMMIT 済みで応答
      // だけ喪失」のケースで UNIQUE 違反 → 409 になり本来の成功が 409 に化ける
      // ため非冪等（既定 = リトライなし）
    )
  } catch (error) {
    // PostgreSQLのUNIQUE制約違反コード = 既に適用済み
    if ((error as { code?: unknown })?.code === '23505') {
      return NextResponse.json(
        { error: 'このキャンペーンは既に適用済みです' },
        { status: 409 }
      )
    }
    return handleApiError(error, 'Election Campaign API')
  }

  // ユーザーIDは末尾4文字のみ表示して機密情報の漏洩リスクを軽減
  logger.info(`[ElectionCampaign] Bonus applied: twitchUserId=***${twitchUserId.slice(-4)}, bonusMb=${VOTE_CAMPAIGN_CONFIG.BONUS_MB}`)

  return NextResponse.json({ success: true })
}

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
 * - streamersテーブルにレコードがない場合は作成（最小限の情報のみ）
 * - 既存レコードがある場合はそのまま使用（上書きしない）
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

  // #663: 読み取りと書き込み（INSERT 2 箇所）が混在する処理のため
  // isPgWriteEnabled() で DB アクセス全体を分岐。フラグ未設定時（既定 'postgrest'）
  // は素通りし、以下の既存実装が従来どおり動く。
  if (isPgWriteEnabled()) {
    return applyVoteCampaignBonusPg(session)
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()

    // streamer_idを取得。既存レコードがあればそのまま使用し、
    // 存在しない場合のみ新規作成（既存レコードを上書きしない）
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
      // 非配信者のstreamersレコードが存在しても、配信者機能はsession.broadcasterTypeで
      // ガードされるため意図しない有効化は起きない。アフィリエイト昇格時は
      // auth callbackのupsert(onConflict: twitch_user_id)で正常に統合される
      const { data: created, error: insertError } = await supabaseAdmin
        .from('streamers')
        .insert({
          twitch_user_id: session.twitchUserId,
          twitch_username: session.twitchUsername,
          twitch_display_name: session.twitchDisplayName,
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
            return handleApiError(retryError ?? insertError, 'Election Campaign API (retry fetch streamer after race condition)')
          }
        } else {
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
