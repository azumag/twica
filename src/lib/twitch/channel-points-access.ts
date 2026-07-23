import { eq } from 'drizzle-orm'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { isPgReadEnabled, isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { isPgMissingColumnError } from '@/lib/db/errors'
import { users as usersTable } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import type { ChannelPointsCapability, DefinitiveCapabilityResult } from './channel-points'

// migration未適用のデプロイ窓（列が存在しない）で読み取りが失敗した場合の安全な既定値。
// 「行が存在しない」場合のnullとは意図的に区別する: ユーザー行自体は存在しうるが
// 新3列だけ読めない状態なので、DBのDEFAULT値（'unknown'/null/false）と同じ値を返す。
const DEPLOY_WINDOW_FALLBACK_STATE: ChannelPointsAccessState = {
  capability: 'unknown',
  checkedAt: null,
  enabled: false,
}

/**
 * users テーブルに永続化されたChannel Points Capability状態のdata layer (#788 子B #790)。
 *
 * 非Affiliateユーザーは有効化前は streamers 行を持たないため、判定結果・確認日時・
 * オプトイン状態は users に保存する。DB_DRIVER (postgrest/pg-read/pg) の既存方針に
 * 従い、読み取りは isPgReadEnabled()、書き込みは isPgWriteEnabled() で分岐する。
 */

export interface ChannelPointsAccessState {
  capability: ChannelPointsCapability
  checkedAt: string | null
  enabled: boolean
}

/**
 * 保存済みのCapability/確認日時/オプトイン状態を読み取る。
 * ユーザー行が存在しない場合は null を返す。
 *
 * migration未適用のデプロイ窓（新3列が存在しない）では例外を投げず
 * DEPLOY_WINDOW_FALLBACK_STATE を返す (#788 子E #793 Fableレビュー Major-3)。
 * これはこの関数のあらゆる呼び出し元（callback、bootstrap、account API）を
 * 個別に保護する代わりに、data layer側で一元的にデプロイ窓耐性を持たせるための設計判断。
 */
export async function getChannelPointsAccessState(
  twitchUserId: string
): Promise<ChannelPointsAccessState | null> {
  if (isPgReadEnabled()) {
    let rows: { capability: string | null; checkedAt: string | null; enabled: boolean | null }[]
    try {
      rows = await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb()
          return db
            .select({
              capability: usersTable.channel_points_capability,
              checkedAt: usersTable.channel_points_capability_checked_at,
              enabled: usersTable.channel_points_enabled,
            })
            .from(usersTable)
            .where(eq(usersTable.twitch_user_id, twitchUserId))
            .limit(1)
        },
        'channel-points-access(get state, pg)',
        // 読み取り専用クエリのため冪等（リトライ可）
        { idempotent: true }
      )
    } catch (error) {
      if (isPgMissingColumnError(error)) {
        logger.warn('[channel-points-access] channel_points_* columns not yet deployed (pg), falling back', {
          twitchUserId,
        })
        return DEPLOY_WINDOW_FALLBACK_STATE
      }
      throw error
    }
    const row = rows[0]
    if (!row) return null
    return {
      capability: (row.capability ?? 'unknown') as ChannelPointsCapability,
      checkedAt: row.checkedAt,
      enabled: row.enabled === true,
    }
  }

  const { data, error } = await getSupabaseAdmin()
    .from('users')
    .select('channel_points_capability, channel_points_capability_checked_at, channel_points_enabled')
    .eq('twitch_user_id', twitchUserId)
    .maybeSingle()

  if (error) {
    // 列未デプロイのデプロイ窓フォールバック（Fableレビュー Major-A修正）。
    // SELECT/order/filterでの列欠落はPostgreSQLが42703を返し、PGRST204は
    // insert/update payloadの列欠落専用（PGRST204のみの判定はSELECT系読み取りでは
    // 実際には作動しない）。本リポジトリの既存前例（collection-existence.ts の
    // isReadColumnMissingError、token-manager.ts の hasScope コメント、
    // reauth/route.ts・check-subscription/route.ts の両コード判定）と同じ規約で
    // 両方を許容する。pg経路の42703（isPgMissingColumnError）と同じ意味。
    if (error.code === 'PGRST204' || error.code === '42703') {
      logger.warn('[channel-points-access] channel_points_* columns not yet deployed (postgrest), falling back', {
        twitchUserId,
      })
      return DEPLOY_WINDOW_FALLBACK_STATE
    }
    logger.error('[channel-points-access] getChannelPointsAccessState failed', {
      twitchUserId,
      error: error.message,
    })
    throw error
  }
  if (!data) return null
  return {
    capability: (data.channel_points_capability ?? 'unknown') as ChannelPointsCapability,
    checkedAt: data.channel_points_capability_checked_at,
    enabled: data.channel_points_enabled === true,
  }
}

/**
 * Capability Probeの「確定」結果 (definitive=true) のみをDBへ保存する。
 * 引数型 DefinitiveCapabilityResult により、429/5xx/network error等の一時失敗を
 * 型レベルで渡せなくしている（呼び出し側の分岐漏れで確定状態が破壊される事故を防ぐ）。
 * checked_at も同時に現在時刻へ更新する。
 */
export async function persistChannelPointsCapability(
  twitchUserId: string,
  result: DefinitiveCapabilityResult
): Promise<void> {
  const checkedAt = new Date().toISOString()

  if (isPgWriteEnabled()) {
    try {
      await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { db } = await getDb()
          return db
            .update(usersTable)
            .set({
              channel_points_capability: result.capability,
              channel_points_capability_checked_at: checkedAt,
            })
            .where(eq(usersTable.twitch_user_id, twitchUserId))
        },
        'channel-points-access(persist capability, pg)',
        // 同じcapability/checkedAtを書くUPDATEのため冪等（リトライ可）
        { idempotent: true }
      )
    } catch (error) {
      // 自動レビュー指摘: 読み取り側(getChannelPointsAccessState)と対になる
      // デプロイ窓フォールバック。列未デプロイ(42703)ではthrowせず、呼び出し元
      // （account API POST/PUT）を500に巻き込まない。保存は単に「今回はできな
      // かった」だけで、次回probe時に再試行される。
      if (isPgMissingColumnError(error)) {
        logger.warn('[channel-points-access] channel_points_* columns not yet deployed (pg), skipping persist', {
          twitchUserId,
        })
        return
      }
      throw error
    }
    return
  }

  const { error } = await getSupabaseAdmin()
    .from('users')
    .update({
      channel_points_capability: result.capability,
      channel_points_capability_checked_at: checkedAt,
    })
    .eq('twitch_user_id', twitchUserId)

  if (error) {
    if (error.code === 'PGRST204' || error.code === '42703') {
      logger.warn('[channel-points-access] channel_points_* columns not yet deployed (postgrest), skipping persist', {
        twitchUserId,
      })
      return
    }
    logger.error('[channel-points-access] persistChannelPointsCapability failed', {
      twitchUserId,
      error: error.message,
    })
    throw error
  }
}

/**
 * Twitch書き込み系route（reward作成/EventSub登録等）が401/403を受けた際に、
 * DB確定状態を同期する共通helper (#788 子E #793)。401→reauth_required、
 * 403→unavailableとして確定保存する。429/5xx等の一時失敗はこのhelperの対象外
 * （呼び出し元は definitive な401/403のときだけこれを呼ぶ）。
 *
 * 同期自体の失敗は呼び出し元の主処理（reward書き込み等のレスポンス）を巻き込まない
 * よう、例外を投げずwarnログのみに留める。
 */
export async function recordChannelPointsApiFailure(
  twitchUserId: string,
  httpStatus: 401 | 403
): Promise<void> {
  const result: DefinitiveCapabilityResult =
    httpStatus === 401
      ? { capability: 'reauth_required', reason: 'unauthorized', httpStatus: 401, definitive: true }
      : { capability: 'unavailable', reason: 'forbidden', httpStatus: 403, definitive: true }

  try {
    await persistChannelPointsCapability(twitchUserId, result)
  } catch (error) {
    logger.warn('[channel-points-access] recordChannelPointsApiFailure failed to persist', {
      twitchUserId,
      httpStatus,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// EnableChannelPointsAccessResultのunionから直接['error']をindexed accessすると、
// ok:trueメンバーにerrorプロパティが無いためTSエラーになる。判定用の理由型を
// 独立して名前付けする。
export type EnableChannelPointsAccessErrorReason = 'capability_not_available' | 'user_not_found'

export type EnableChannelPointsAccessResult =
  | { ok: true; streamerId: string }
  | { ok: false; error: EnableChannelPointsAccessErrorReason }

/**
 * enable_channel_points_streamer_access RPC の例外メッセージ（RAISE EXCEPTION の
 * 文字列そのもの）を、PostgREST/pg直結どちらの経路でも同じtypedエラーへ写像する。
 * 両経路ともPostgresのエラーmessageフィールドにRAISE EXCEPTIONの文字列がそのまま
 * 載るため、同一のmessage起点で判定できる（driver parity）。
 */
function classifyEnableRpcError(message: string): EnableChannelPointsAccessErrorReason | null {
  if (message.includes('CAPABILITY_NOT_AVAILABLE')) return 'capability_not_available'
  if (message.includes('USER_NOT_FOUND')) return 'user_not_found'
  return null
}

/**
 * 非Affiliateユーザーの明示的オプトインを原子的に処理するRPCを呼ぶ (#788 子B #790)。
 * DB側で `channel_points_capability = 'available'` を再検証してから
 * `channel_points_enabled = true` にし、streamers 行をidempotentにUPSERTする
 * （既存streamer設定は上書きしない）。同時実行・二重送信でも重複作成しない。
 */
export async function enableChannelPointsStreamerAccess(
  twitchUserId: string
): Promise<EnableChannelPointsAccessResult> {
  if (isPgWriteEnabled()) {
    try {
      const streamerId = await withDbRetry(
        async () => {
          // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
          const { sql } = await getDb()
          const rows = await sql<{ streamer_id: string | null }[]>`
            select enable_channel_points_streamer_access(p_twitch_user_id => ${twitchUserId}) as streamer_id
          `
          return rows[0]?.streamer_id ?? null
        },
        'channel-points-access(enable rpc, pg)',
        // RPC本体（UPDATE + INSERT...ON CONFLICT DO UPDATE）は同じ入力なら
        // 何度実行しても同じ終了状態に収束するため冪等（リトライ可）。
        { idempotent: true }
      )
      if (!streamerId) {
        throw new Error('enable_channel_points_streamer_access returned no streamer_id')
      }
      return { ok: true, streamerId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const classified = classifyEnableRpcError(message)
      if (classified) return { ok: false, error: classified }
      logger.error('[channel-points-access] enableChannelPointsStreamerAccess RPC failed (pg)', {
        twitchUserId,
        error: message,
      })
      throw error
    }
  }

  const { data, error } = await getSupabaseAdmin().rpc('enable_channel_points_streamer_access', {
    p_twitch_user_id: twitchUserId,
  })

  if (error) {
    const classified = classifyEnableRpcError(error.message)
    if (classified) return { ok: false, error: classified }
    logger.error('[channel-points-access] enableChannelPointsStreamerAccess RPC failed', {
      twitchUserId,
      error: error.message,
    })
    throw error
  }

  if (!data) {
    throw new Error('enable_channel_points_streamer_access RPC returned no data')
  }

  return { ok: true, streamerId: data as string }
}
