import { NextResponse } from 'next/server'

import { getSession, canUseStreamerFeatures } from '@/lib/session'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { exchangeCodeForTokens, getTwitchUser, isInvalidAuthorizationCodeError } from '@/lib/twitch/auth'
import type { TwitchTokens, TwitchUser } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { COOKIE_NAMES, ERROR_MESSAGES } from '@/lib/constants'
import { logger } from '@/lib/logger'
// -----------------------------------------------------------------------------
// #572 (#570 パイロット踏襲): pg 直結経路。
// handleLinkedAccountCallback の DB アクセス（streamers 読み取り +
// twitch_bot_accounts の update/insert + streamer_chat_sender_settings の upsert）
// は書き込みを含む一連の処理のため、isPgWriteEnabled() で DB アクセス全体を分岐
// する（token-manager.ts 冒頭のフラグ使い分け方針と同じ）。既存 supabase-js 実装は
// 1 文字も変えず（else 節への再インデントのみ）、フラグ未設定時は従来どおり動く。
// -----------------------------------------------------------------------------
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import {
  streamers as streamersTable,
  streamerChatSenderSettings as streamerChatSenderSettingsTable,
  twitchBotAccounts as twitchBotAccountsTable,
} from '@/lib/db/schema'

function redirectToSettings(baseUrl: string, params: Record<string, string>) {
  const searchParams = new URLSearchParams(params)
  return NextResponse.redirect(`${baseUrl}/dashboard/settings?${searchParams.toString()}`)
}

/**
 * handleLinkedAccountCallback の DB 永続化部分の pg 直結実装 (#572)
 *
 * 成功時は null、失敗時は redirectToSettings に渡す bot_error 値を返す
 * （既存経路の各エラー分岐がすべて 'database_error' でリダイレクトするのと同じ
 * 外部挙動。DB エラーをここで throw すると呼び出し元の外側 catch により
 * 'bot_auth_failed' という別のエラー種別に化けてしまうため、必ず値で返す）。
 *
 * PostgREST 実装との対応:
 * - streamers / 既存 BOT アカウントの .maybeSingle() は一意条件
 *   （streamers.twitch_user_id UNIQUE (00001) / twitch_bot_accounts の部分一意
 *   インデックス idx_twitch_bot_accounts_streamer_owner (00040): (streamer_id,
 *   owner_type) WHERE owner_type = 'streamer'）により最大 1 行のため、
 *   LIMIT 1 + rows[0] ?? null で同じ外部挙動。
 * - 既存 BOT の有無による update / insert の分岐と .select('id').single() は
 *   .returning({ id }) で形状を合わせる（.single() の 0 行エラーは
 *   returning 空配列 → 'database_error' として再現）。
 * - .upsert() は streamer_chat_sender_settings の PK が streamer_id
 *   （migration 00040: streamer_id UUID PRIMARY KEY）であり onConflict 指定が
 *   無いため PK が conflict target。Drizzle では
 *   .onConflictDoUpdate({ target: streamer_id }) が等価。
 * - updated_at は DB トリガー（00040 update_*_updated_at）が両経路共通で維持する
 *   ため手動セットしない（既存実装も未セット）。
 * - トークン値はログに出さない（既存のログ慣習どおり error オブジェクトのみ）。
 */
async function persistLinkedAccountPg(params: {
  streamerTwitchUserId: string
  botUser: TwitchUser
  tokens: TwitchTokens
  expiresAt: Date
}): Promise<'database_error' | null> {
  const { streamerTwitchUserId, botUser, tokens, expiresAt } = params
  const linkedTwitchUserId = botUser.id

  let streamer: { id: string } | null = null
  let streamerError: unknown = null
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, streamerTwitchUserId))
          .limit(1)
      },
      'linkedAccountCallback(streamer)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    streamer = rows[0] ?? null
  } catch (error) {
    streamerError = error
  }

  if (streamerError || !streamer) {
    logger.error('Linked account callback: failed to find streamer', {
      twitchUserId: streamerTwitchUserId,
      linkedTwitchUserId,
      error: streamerError,
    })
    return 'database_error'
  }
  // withDbRetry の queryFn（closure）から参照するため const に固定する
  const streamerId = streamer.id

  // 既存 postgrest 経路の botAccountFields と同一内容（既存コード無変更の要件上、
  // pg 経路側で独立に組み立てる）
  const botAccountFields = {
    twitch_user_id: botUser.id,
    twitch_username: botUser.login,
    twitch_display_name: botUser.display_name,
    twitch_access_token: tokens.access_token,
    twitch_refresh_token: tokens.refresh_token,
    twitch_token_expires_at: expiresAt.toISOString(),
    scopes: tokens.scope ?? [],
    status: 'active',
    last_error: null,
  }

  let existingBotAccountId: string | null = null
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .select({ id: twitchBotAccountsTable.id })
          .from(twitchBotAccountsTable)
          .where(
            and(
              eq(twitchBotAccountsTable.owner_type, 'streamer'),
              eq(twitchBotAccountsTable.streamer_id, streamerId)
            )
          )
          .limit(1)
      },
      'linkedAccountCallback(existing bot)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    existingBotAccountId = rows[0]?.id ?? null
  } catch (existingBotError) {
    logger.error('Linked account callback: failed to fetch existing linked account', {
      twitchUserId: streamerTwitchUserId,
      linkedTwitchUserId,
      error: existingBotError,
    })
    return 'database_error'
  }

  let botAccountId: string | null = null
  try {
    if (existingBotAccountId) {
      const targetBotAccountId = existingBotAccountId
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb()
          return db
            .update(twitchBotAccountsTable)
            .set(botAccountFields)
            .where(eq(twitchBotAccountsTable.id, targetBotAccountId))
            .returning({ id: twitchBotAccountsTable.id })
        },
        'linkedAccountCallback(update bot)',
        // リトライしても同じ値を書く UPDATE のため冪等（リトライ可）
        { idempotent: true },
      )
      botAccountId = rows[0]?.id ?? null
    } else {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb()
          return db
            .insert(twitchBotAccountsTable)
            .values({
              ...botAccountFields,
              owner_type: 'streamer',
              streamer_id: streamerId,
            })
            .returning({ id: twitchBotAccountsTable.id })
        },
        'linkedAccountCallback(insert bot)',
        // ON CONFLICT の無い INSERT は再実行で部分一意インデックス（00040）違反に
        // なりうるため非冪等（既定 = リトライなし）
      )
      botAccountId = rows[0]?.id ?? null
    }
  } catch (error) {
    logger.error('Linked account callback: failed to save linked account', {
      twitchUserId: streamerTwitchUserId,
      linkedTwitchUserId,
      error,
    })
    return 'database_error'
  }

  if (!botAccountId) {
    // 既存経路の .single() は 0 行時に PGRST116 エラー → database_error になる。
    // update 対象行の消失（並行削除）等の希少ケースでも同じ外部挙動に合わせる。
    logger.error('Linked account callback: failed to save linked account', {
      twitchUserId: streamerTwitchUserId,
      linkedTwitchUserId,
      error: null,
    })
    return 'database_error'
  }
  const savedBotAccountId = botAccountId

  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb()
        return db
          .insert(streamerChatSenderSettingsTable)
          .values({
            streamer_id: streamerId,
            sender_mode: 'custom_bot',
            custom_bot_account_id: savedBotAccountId,
          })
          .onConflictDoUpdate({
            // conflict target は PK の streamer_id（migration 00040:
            // streamer_id UUID PRIMARY KEY。supabase-js の .upsert() は
            // onConflict 未指定時 PK を衝突対象にする）
            target: streamerChatSenderSettingsTable.streamer_id,
            set: {
              sender_mode: 'custom_bot',
              custom_bot_account_id: savedBotAccountId,
            },
          })
      },
      'linkedAccountCallback(sender settings upsert)',
      // ON CONFLICT DO UPDATE の upsert はリトライしても同じ最終状態のため冪等
      { idempotent: true },
    )
  } catch (senderSettingsError) {
    logger.error('Linked account callback: failed to save chat sender settings', {
      twitchUserId: streamerTwitchUserId,
      linkedTwitchUserId,
      error: senderSettingsError,
    })
    return 'database_error'
  }

  return null
}

export async function handleLinkedAccountCallback({
  baseUrl,
  code,
  redirectUri,
}: {
  baseUrl: string
  code: string
  redirectUri: string
}) {
  const session = await getSession()
  if (!session || !canUseStreamerFeatures(session)) {
    return redirectToSettings(baseUrl, { bot_error: ERROR_MESSAGES.UNAUTHORIZED })
  }

  const response = redirectToSettings(baseUrl, { bot: 'connected' })

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri)
    if (!tokens.scope?.includes(ADDITIONAL_SCOPES.CHAT_WRITE)) {
      return redirectToSettings(baseUrl, { bot_error: 'missing_chat_scope' })
    }

    const botUser = await getTwitchUser(tokens.access_token)
    if (botUser.id === session.twitchUserId) {
      return redirectToSettings(baseUrl, { bot_error: 'same_account' })
    }

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)

    // #572: DB 永続化（書き込みを含む一連の処理）のみをフラグで分岐する。
    // フラグ未設定（既定 'postgrest'）時は else 節の既存 supabase-js 実装が
    // そのまま実行され、挙動は完全に不変（1 文字も変更していない。再インデントのみ）。
    if (isPgWriteEnabled()) {
      const pgBotError = await persistLinkedAccountPg({
        streamerTwitchUserId: session.twitchUserId,
        botUser,
        tokens,
        expiresAt,
      })
      if (pgBotError) {
        return redirectToSettings(baseUrl, { bot_error: pgBotError })
      }
    } else {
      const supabaseAdmin = getSupabaseAdmin()

      const { data: streamer, error: streamerError } = await supabaseAdmin
        .from('streamers')
        .select('id')
        .eq('twitch_user_id', session.twitchUserId)
        .maybeSingle()

      if (streamerError || !streamer) {
        logger.error('Linked account callback: failed to find streamer', {
          twitchUserId: session.twitchUserId,
          linkedTwitchUserId: botUser.id,
          error: streamerError,
        })
        return redirectToSettings(baseUrl, { bot_error: 'database_error' })
      }

      const botAccountFields = {
        twitch_user_id: botUser.id,
        twitch_username: botUser.login,
        twitch_display_name: botUser.display_name,
        twitch_access_token: tokens.access_token,
        twitch_refresh_token: tokens.refresh_token,
        twitch_token_expires_at: expiresAt.toISOString(),
        scopes: tokens.scope ?? [],
        status: 'active',
        last_error: null,
      }

      const { data: existingBotAccount, error: existingBotError } = await supabaseAdmin
        .from('twitch_bot_accounts')
        .select('id')
        .eq('owner_type', 'streamer')
        .eq('streamer_id', streamer.id)
        .maybeSingle()

      if (existingBotError) {
        logger.error('Linked account callback: failed to fetch existing linked account', {
          twitchUserId: session.twitchUserId,
          linkedTwitchUserId: botUser.id,
          error: existingBotError,
        })
        return redirectToSettings(baseUrl, { bot_error: 'database_error' })
      }

      const botAccountResult = existingBotAccount
        ? await supabaseAdmin
            .from('twitch_bot_accounts')
            .update(botAccountFields)
            .eq('id', existingBotAccount.id)
            .select('id')
            .single()
        : await supabaseAdmin
            .from('twitch_bot_accounts')
            .insert({
              ...botAccountFields,
              owner_type: 'streamer',
              streamer_id: streamer.id,
            })
            .select('id')
            .single()

      if (botAccountResult.error) {
        logger.error('Linked account callback: failed to save linked account', {
          twitchUserId: session.twitchUserId,
          linkedTwitchUserId: botUser.id,
          error: botAccountResult.error,
        })
        return redirectToSettings(baseUrl, { bot_error: 'database_error' })
      }

      const { error: senderSettingsError } = await supabaseAdmin
        .from('streamer_chat_sender_settings')
        .upsert({
          streamer_id: streamer.id,
          sender_mode: 'custom_bot',
          custom_bot_account_id: botAccountResult.data.id,
        })

      if (senderSettingsError) {
        logger.error('Linked account callback: failed to save chat sender settings', {
          twitchUserId: session.twitchUserId,
          linkedTwitchUserId: botUser.id,
          error: senderSettingsError,
        })
        return redirectToSettings(baseUrl, { bot_error: 'database_error' })
      }
    }

    logger.info('Linked account connected for chat announcements', {
      twitchUserId: session.twitchUserId,
      linkedTwitchUserId: botUser.id,
    })

    response.cookies.delete(COOKIE_NAMES.BOT_AUTH_STATE)
    return response
  } catch (error) {
    const errorType = isInvalidAuthorizationCodeError(error)
      ? 'invalid_authorization_code'
      : 'bot_auth_failed'
    logger.error('Linked account callback failed', {
      twitchUserId: session.twitchUserId,
      errorType,
      error,
    })
    return redirectToSettings(baseUrl, { bot_error: errorType })
  }
}
