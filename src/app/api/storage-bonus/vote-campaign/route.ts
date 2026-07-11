import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { validateCSRFToken } from '@/lib/csrf'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError } from '@/lib/error-handler'
import { VOTE_CAMPAIGN_CONFIG, ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'
import type { ApiRateLimitResponse } from '@/types/api'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() / isPgWriteEnabled() が false を返すため getDb() は一切
// 呼ばれず、既存の supabase-js 経路が従来どおり実行される。
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled, isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { streamers as streamersTable, streamerStorageBonus as streamerStorageBonusTable } from '@/lib/db/schema'

interface VoteCampaignDriverError {
  code?: string
  message: string
}

/**
 * streamers.id 取得（既存レコードの有無確認）の pg 直結実装 (#663)
 * PostgREST 実装との対応: .maybeSingle() は twitch_user_id の UNIQUE 制約
 * （migration 00001）により最大 1 行のため LIMIT 1 + rows[0] ?? null で同じ
 * 外部挙動。既存コードは destructure で error を確認しない（data のみ利用）ため、
 * pg 版も取得失敗時は null（=未作成扱い、後続の INSERT 分岐へ進む）に揃える。
 */
async function fetchStreamerIdPg(twitchUserId: string): Promise<{ id: string } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'vote-campaign(fetch streamer)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    return rows[0] ?? null
  } catch {
    return null
  }
}

/**
 * streamers への INSERT（新規レコード作成）の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応: .select('id').single() は .returning({id}) の
 * rows[0] で同じ外部挙動。UNIQUE(twitch_user_id) 違反時は既存経路と同じ
 * '23505' を code として返す（呼び出し元が並行作成レースのリトライ判定に使う）。
 * ON CONFLICT の無い一度きりの INSERT のため非冪等（既定 = リトライなし。
 * 接続断で「実際は成功したか不明」な状態のまま再送すると 23505 の誤検知や
 * 二重行作成の恐れがある）。
 */
async function insertStreamerPg(payload: {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
}): Promise<{ data: { id: string } | null; error: VoteCampaignDriverError | null }> {
  try {
    const rows = await withDbRetry(async () => {
      // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
      const { db } = await getDb()
      return db
        .insert(streamersTable)
        .values({
          twitch_user_id: payload.twitchUserId,
          twitch_username: payload.twitchUsername,
          twitch_display_name: payload.twitchDisplayName,
        })
        .returning({ id: streamersTable.id })
    }, 'vote-campaign(insert streamer)')
    // 非冪等のため withDbRetry の第3引数（idempotent オプション）は渡さない
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return {
      data: null,
      error: {
        code: typeof code === 'string' ? code : undefined,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * streamer_storage_bonus への INSERT（ボーナス付与）の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応: UNIQUE(streamer_id, type, memo) 違反時は既存経路と
 * 同じ '23505' を code として返す（呼び出し元が「既に適用済み」409 判定に使う）。
 * 一度きりの状態遷移（ボーナス付与）のため非冪等（既定 = リトライなし。接続断で
 * 「実際は成功したか不明」な状態のまま再送すると二重付与の恐れがある。この点は
 * 課金・ポイント加算系と同じ安全側の判断）。
 */
async function insertStorageBonusPg(payload: {
  streamerId: string
}): Promise<{ error: VoteCampaignDriverError | null }> {
  try {
    await withDbRetry(async () => {
      // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
      const { db } = await getDb()
      return db.insert(streamerStorageBonusTable).values({
        streamer_id: payload.streamerId,
        amount_mb: VOTE_CAMPAIGN_CONFIG.BONUS_MB,
        type: VOTE_CAMPAIGN_CONFIG.TYPE,
        memo: VOTE_CAMPAIGN_CONFIG.MEMO,
      })
    }, 'vote-campaign(insert bonus)')
    // 非冪等のため withDbRetry の第3引数（idempotent オプション）は渡さない
    return { error: null }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    return {
      error: {
        code: typeof code === 'string' ? code : undefined,
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
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

  try {
    const supabaseAdmin = getSupabaseAdmin()

    // streamer_idを取得。既存レコードがあればそのまま使用し、
    // 存在しない場合のみ新規作成（既存レコードを上書きしない）
    // #663: 読み取り専用のため isPgReadEnabled() で分岐。
    const existing = isPgReadEnabled()
      ? await fetchStreamerIdPg(session.twitchUserId)
      : (
          await supabaseAdmin
            .from('streamers')
            .select('id')
            .eq('twitch_user_id', session.twitchUserId)
            .maybeSingle()
        ).data

    let streamerId: string
    if (existing) {
      streamerId = existing.id
    } else {
      // 将来アフィリエイトになった時のために、今のうちにレコードを作成しておく
      // 非配信者のstreamersレコードが存在しても、配信者機能はsession.broadcasterTypeで
      // ガードされるため意図しない有効化は起きない。アフィリエイト昇格時は
      // auth callbackのupsert(onConflict: twitch_user_id)で正常に統合される
      // #663: 書き込みのため isPgWriteEnabled() で分岐。
      const { data: created, error: insertError } = isPgWriteEnabled()
        ? await insertStreamerPg({
            twitchUserId: session.twitchUserId,
            twitchUsername: session.twitchUsername,
            twitchDisplayName: session.twitchDisplayName,
          })
        : await supabaseAdmin
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
          const retried = isPgReadEnabled()
            ? await fetchStreamerIdPg(session.twitchUserId)
            : (
                await supabaseAdmin
                  .from('streamers')
                  .select('id')
                  .eq('twitch_user_id', session.twitchUserId)
                  .maybeSingle()
              ).data
          if (retried) {
            streamerId = retried.id
          } else {
            return handleApiError(insertError, 'Election Campaign API (retry fetch streamer after race condition)')
          }
        } else {
          return handleApiError(insertError, 'Election Campaign API (insert streamer)')
        }
      } else {
        streamerId = created.id
      }
    }

    // ボーナスを挿入（UNIQUE(streamer_id, type, memo)制約で重複適用を防止）
    // #663: 書き込みのため isPgWriteEnabled() で分岐。
    const { error } = isPgWriteEnabled()
      ? await insertStorageBonusPg({ streamerId })
      : await supabaseAdmin
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
