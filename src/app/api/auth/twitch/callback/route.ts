import { type NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers'
import { exchangeCodeForTokens, getTwitchUser, isInvalidAuthorizationCodeError, getTwitchAuthUrl } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { saveTwitchScopes } from '@/lib/twitch/token-manager'

import { handleAuthError } from '@/lib/auth-error-handler'
import { COOKIE_NAMES, SESSION_CONFIG, ERROR_MESSAGES, getSessionCookieOptions, getDeleteCookieOptions, STATE_COOKIE_OPTIONS } from '@/lib/constants'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { logger } from '@/lib/logger.server'
import { getBaseUrl } from '@/lib/url-utils'
import { signSession } from '@/lib/session'
import { handleLinkedAccountCallback } from '@/lib/twitch/linked-account-auth'
import { guardWriteRedirect } from '@/lib/maintenance/guard'
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() / isPgWriteEnabled() が false を返すため getDb() は一切
// 呼ばれず、既存の supabase-js 経路が従来どおり実行される。読み取り専用のクエリは
// isPgReadEnabled()、書き込みは isPgWriteEnabled() で分岐する（token-manager.ts
// 冒頭のフラグ使い分け方針と同じ）。
// ---------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'

import { withDbRetry } from '@/lib/db/retry'
import { streamers as streamersTable, users as usersTable } from '@/lib/db/schema'
import { isDefinitiveCapabilityResult, probeChannelPointsCapability } from '@/lib/twitch/channel-points'
import { persistChannelPointsCapability } from '@/lib/twitch/channel-points-access'

interface AuthCallbackDriverError {
  code?: string
  message: string
}

/**
 * スコープ乖離チェック用の既存ユーザー読み取りの pg 直結実装 (#663)
 * PostgREST 実装との対応: .maybeSingle() は twitch_user_id の UNIQUE 制約
 * （migration 00001）により最大 1 行のため、LIMIT 1 + rows[0] ?? null で同じ
 * 外部挙動。
 */
async function fetchExistingUserScopesPg(
  twitchUserId: string
): Promise<{ data: { twitch_scopes: string[] | null } | null; error: AuthCallbackDriverError | null }> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        return db
          .select({ twitch_scopes: usersTable.twitch_scopes })
          .from(usersTable)
          .where(eq(usersTable.twitch_user_id, twitchUserId))
          .limit(1)
      },
      'auth callback(existing scopes)',
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    )
    return { data: rows[0] ?? null, error: null }
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/**
 * users への UPSERT（トークン・プロフィール保存）の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応: onConflict('twitch_user_id') の UPSERT は users の
 * twitch_user_id UNIQUE 制約（migration 00001）を conflict target とした
 * INSERT ... ON CONFLICT DO UPDATE と等価。既存経路は upsertError を検知次第
 * ログ出力後に throw し、直後の外側 catch で 'database_error' へ変換する。
 * pg 版もエラー時はここで一度ログしてから throw することで、同じ2段ログ
 * （個別ログ + 外側 catch の "Database error details" ログ）を再現する。
 *
 * 書き込む値は呼び出し元で計算済みの固定値のため、接続断リトライしても同じ
 * 内容を書く UPSERT ＝冪等。
 */
async function upsertAuthUserPg(payload: {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
  twitchProfileImageUrl: string | null
  accessToken: string
  refreshToken: string
  expiresAtIso: string
}): Promise<void> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        const values = {
          twitch_user_id: payload.twitchUserId,
          twitch_username: payload.twitchUsername,
          twitch_display_name: payload.twitchDisplayName,
          twitch_profile_image_url: payload.twitchProfileImageUrl,
          twitch_access_token: payload.accessToken,
          twitch_refresh_token: payload.refreshToken,
          twitch_token_expires_at: payload.expiresAtIso,
        }
        return db
          .insert(usersTable)
          .values(values)
          .onConflictDoUpdate({ target: usersTable.twitch_user_id, set: values })
      },
      'auth callback(upsert user)',
      { idempotent: true },
    )
  } catch (error) {
    logger.error('Auth callback: User upsert failed', {
      twitchUserId: payload.twitchUserId,
      error,
      code: (error as { code?: unknown } | null)?.code,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * streamers への UPSERT（アフィリエイト/パートナー時のみ）の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応が重要な差異: 既存経路は
 * `await supabaseAdmin.from('streamers').upsert(...)` の戻り値を分割代入せず
 * 破棄しているため、外側の try/catch は「クエリ結果の error フィールド」は
 * 一切見ておらず、fetch() 自体が reject した場合（実質的にほぼ発生しない）だけを
 * 捕捉する ＝ クエリレベルのエラー（例: 制約違反）は事実上黙って握りつぶされる
 * 既存動作になっている。postgres.js は全クエリエラーを throw するため、pg 版で
 * 何もしなければ「今まで無視されていたエラー」が新たに 'database_error' で
 * コールバック全体を失敗させてしまい、外部挙動が変わってしまう。
 * token-manager.ts の getBotAccountForChatPg と同じ判断で、ここでも意図的に
 * エラーを catch して握りつぶし（warn ログのみ）、既存の「結果を確認しない
 * best-effort UPSERT」という外部挙動を再現する。
 */
async function upsertAuthStreamerPg(payload: {
  twitchUserId: string
  twitchUsername: string
  twitchDisplayName: string
  twitchProfileImageUrl: string | null
}): Promise<void> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb()
        const values = {
          twitch_user_id: payload.twitchUserId,
          twitch_username: payload.twitchUsername,
          twitch_display_name: payload.twitchDisplayName,
          twitch_profile_image_url: payload.twitchProfileImageUrl,
        }
        return db
          .insert(streamersTable)
          .values(values)
          .onConflictDoUpdate({ target: streamersTable.twitch_user_id, set: values })
      },
      'auth callback(upsert streamer)',
      { idempotent: true },
    )
  } catch (error) {
    // 既存 postgrest 経路はこの upsert の結果（error）を確認せず無視する
    // （best-effort）。pg 直結では失敗が throw になるため catch で握りつぶし、
    // 同じ外部挙動（コールバック全体は失敗させない）に合わせる。
    logger.warn('Auth callback: Streamer upsert failed (ignored, best-effort)', {
      twitchUserId: payload.twitchUserId,
      error,
    })
  }
}

/**
 * TOS 同意確認読み取りの pg 直結実装 (#663)
 * PostgREST 実装との対応: .maybeSingle() は twitch_user_id の UNIQUE 制約により
 * 最大 1 行のため LIMIT 1 + rows[0] ?? null で同じ外部挙動。
 * 既知の差異: 既存経路は destructure で error を確認しないため、クエリレベルの
 * エラー時は data=null → `null?.tos_accepted_at !== null` が true と評価され
 * 「TOS 同意済み扱い」に落ちる（意図せぬ既存の副作用）。pg 版は全エラーが throw
 * になり外側 catch で hasTosAccepted=false（TOS 未同意扱い＝より安全側）のまま
 * 継続するため、この極めて稀なケース（クエリは成功するが行取得だけ失敗する状況）
 * でのみ挙動が異なる。安全側にしか倒れないため許容する。
 */
/**
 * channel_points_enabled フラグ単独読み取りの pg 直結実装 (#788 子C #791)。
 *
 * 意図的に users upsert / 他の読み取りから独立させている（Fable設計レビュー
 * Critical-1）: このフラグ読み取りが users upsert に混ざっていると、
 * migration未適用のデプロイ窓で列が存在せず upsert 自体が失敗し、
 * affiliate/partnerを含む全ユーザーのログインが壊れてしまう。呼び出し元は
 * このクエリのあらゆる失敗（列未適用の42703を含む）を catch し、false へ
 * フォールバックしてログインを継続させる。
 */
async function fetchChannelPointsEnabledFlagPg(twitchUserId: string): Promise<boolean> {
  const rows = await withDbRetry(
    async () => {
      // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
      const { db } = await getDb()
      return db
        .select({ channel_points_enabled: usersTable.channel_points_enabled })
        .from(usersTable)
        .where(eq(usersTable.twitch_user_id, twitchUserId))
        .limit(1)
    },
    'auth callback(channel points enabled flag)',
    // 読み取り専用クエリのため冪等（リトライ可）
    { idempotent: true }
  )
  return rows[0]?.channel_points_enabled === true
}

async function fetchTosAcceptedPg(twitchUserId: string): Promise<{ tos_accepted_at: string | null } | null> {
  const rows = await withDbRetry(
    async () => {
      // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
      const { db } = await getDb()
      return db
        .select({ tos_accepted_at: usersTable.tos_accepted_at })
        .from(usersTable)
        .where(eq(usersTable.twitch_user_id, twitchUserId))
        .limit(1)
    },
    'auth callback(tos check)',
    // 読み取り専用クエリのため冪等（リトライ可）
    { idempotent: true },
  )
  return rows[0] ?? null
}

export async function GET(request: NextRequest) {
  // #694 Stage 3: このrouteはGETだがuser upsert等の書き込み副作用を持つため
  // middlewareの一律ブロック（POST/PUT/PATCH/DELETEのみ対象）ではカバーされない。
  // オーナー決定「ログインもブロックする」に従い、他の全処理より前に個別で
  // maintenance guardをかける。config/maintenance-write-surfaces.json の
  // /api/auth/twitch/callback エントリ（maintenanceBehavior: "redirect"）に対応。
  const maintenanceRedirect = guardWriteRedirect({
    operation: 'auth.twitch.callback',
    redirectTo: '/?maintenance=1',
  })
  if (maintenanceRedirect) {
    return maintenanceRedirect
  }

  // 開発環境ではリクエストのホストから動的にベースURLを取得
  const baseUrl = getBaseUrl(request)

  const ip = getClientIp(request);
  const identifier = `ip:${ip}`;
  const rateLimitResult = await checkRateLimit(rateLimits.authCallback, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.redirect(
      `${baseUrl}/?error=${encodeURIComponent(ERROR_MESSAGES.RATE_LIMIT_EXCEEDED)}`
    );
  }

  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(
      `${baseUrl}/?error=${encodeURIComponent(error)}`
    )
  }

  if (!code || !state) {
    return handleAuthError(
      new Error('Missing OAuth parameters'),
      'missing_params',
      { code: !!code, state: !!state },
      { baseUrl }
    )
  }

  // Verify state
  const cookieStore = await cookies()
  const storedBotState = cookieStore.get(COOKIE_NAMES.BOT_AUTH_STATE)?.value
  if (storedBotState && state === storedBotState) {
    const redirectUri = `${baseUrl}/api/auth/twitch/callback`
    return handleLinkedAccountCallback({
      baseUrl,
      code,
      redirectUri,
    })
  }

  const storedState = cookieStore.get(COOKIE_NAMES.AUTH_STATE)?.value

  if (!storedState || state !== storedState) {
    return handleAuthError(
      new Error('Invalid state parameter'),
      'invalid_state',
      { storedState: !!storedState, stateMatch: storedState === state },
      { baseUrl }
    )
  }

  try {

    // Twitchへのトークン交換リクエストでは、元のリダイレクトURIと一致する必要がある
    const redirectUri = `${baseUrl}/api/auth/twitch/callback`

    let tokens
    try {
      tokens = await exchangeCodeForTokens(code, redirectUri)
    } catch (error) {
      const errorType = isInvalidAuthorizationCodeError(error)
        ? 'invalid_authorization_code'
        : 'twitch_auth_failed'

      // OAuth authorization code は短期有効だが Twitch 側で再交換可能な秘匿値のため、
      // 部分出力も含めてログに残さない。エラーの種別と Twitch 側のレスポンスのみで切り分ける。
      // The OAuth `code` is a short-lived but exchangeable secret — even a prefix
      // could aid replay attacks if logs leak, so we omit it entirely.
      const response = await handleAuthError(
        error,
        errorType,
        undefined,
        { baseUrl }
      )

      // Consume auth state on token exchange failure to avoid stale/replayed code retries.
      response.cookies.set(COOKIE_NAMES.AUTH_STATE, '', getDeleteCookieOptions())
      return response
    }

    let twitchUser
    try {
      twitchUser = await getTwitchUser(tokens.access_token)
    } catch (error) {
      // この時点では Twitch user 情報が未取得のため twitchUserId は不明。
      // access_token を context に部分出力しない（漏洩リスク）。
      // We don't yet know the twitchUserId here, and access_token must never
      // appear in logs (even as a prefix) — the issue's signature is enough.
      return handleAuthError(
        error,
        'twitch_user_fetch_failed',
        undefined,
        { baseUrl }
      )
    }

    // Check if user can be a streamer (affiliate or partner)
    // #788 子E #793: これはAffiliate/Partnerの既存自動プロビジョニング専用の判定であり、
    // 意図的にbroadcaster_typeのみを見ている。非Affiliateユーザーの明示的オプトインによる
    // streamers行作成は/api/account/channel-points PUT (enableChannelPointsStreamerAccess)
    // という別経路で行われ、ここでは変更しない。
    const canBeStreamer = twitchUser.broadcaster_type === 'affiliate' || twitchUser.broadcaster_type === 'partner'

    // スコープ復元ガードCookieを確認（login側でDB障害等によりスコープ復元に失敗した場合に設定される）
    // Check scope restoration guard cookie (set by login route when scope restoration fails)
    const scopeRestoreFailedState = cookieStore.get(COOKIE_NAMES.SCOPE_RESTORE_FAILED)?.value
    const scopeRestoreFailed = scopeRestoreFailedState === state
    // 再認証フロー判定Cookie（reauth APIで設定）
    // Re-auth flow marker cookie (set by reauth API)
    const reauthState = cookieStore.get(COOKIE_NAMES.REAUTH_STATE)?.value
    const isReauthFlow = reauthState === state
    // スコープ自動復元リダイレクト判定Cookie（1回目callbackで設定される）
    // Auto scope recovery marker cookie (set by first callback when redirecting)
    const scopeRecoveryState = cookieStore.get(COOKIE_NAMES.SCOPE_RECOVERY)?.value
    const isScopeRecovery = scopeRecoveryState === state

    // --- スコープ乖離チェック（upsert前） ---
    // Cookie消失等でloginルートがスコープ復元できなかった場合、トークンにDBの追加スコープが
    // 含まれていない可能性がある。upsert前に検出し、不足スコープを含むOAuthフローに
    // 自動リダイレクトする。DB未変更のため、2回目OAuthが失敗/中断しても安全。
    //
    // Scope divergence check BEFORE upsert.
    // When login route couldn't restore scopes (cookie loss), the token may lack DB's additional
    // scopes. Detect before upsert and auto-redirect to OAuth with missing scopes.
    // DB is unchanged, so if the 2nd OAuth fails/is interrupted, previous state is preserved.
    let skipScopeSave = false
    if (!isReauthFlow && !scopeRestoreFailed && !isScopeRecovery) {
      try {
        // #663: 読み取り専用のため isPgReadEnabled() で分岐。
        const { data: existingUser, error: existingScopeError } = await fetchExistingUserScopesPg(twitchUser.id)

        if (existingScopeError) {
          // DB読み取り失敗: fail-safe(スキップ)で保護。リダイレクトできない（スコープ不明）
          // DB read failure: fail-safe skip. Cannot redirect (unknown scopes).
          skipScopeSave = true
          logger.warn('Auth callback: Skipping scope save due to existing scope read failure', {
            twitchUserId: twitchUser.id,
            error: existingScopeError.message,
          })
        } else if (existingUser?.twitch_scopes) {
          const validAdditionalScopes = Object.values(ADDITIONAL_SCOPES) as string[]
          const existingAdditional = (existingUser.twitch_scopes as string[]).filter(
            (s: string) => validAdditionalScopes.includes(s)
          )

          if (existingAdditional.length > 0) {
            const missingScopes = existingAdditional.filter(
              (s: string) => !tokens.scope.includes(s)
            )
            if (missingScopes.length > 0) {
              // トークンにDB追加スコープが不足 → 不足スコープを含むOAuthフローに自動リダイレクト
              // DBに何も書かずreturnするため、2回目OAuthが失敗しても旧状態が維持される。
              // forceVerify: falseでユーザーが既に許可済みならTwitch同意画面を非表示。
              // SCOPE_RECOVERYを設定し、2回目callbackで乖離チェックをスキップ（無限ループ防止）。
              //
              // Token missing DB additional scopes → auto-redirect to OAuth with missing scopes.
              // No DB writes before return, so previous state is preserved if 2nd OAuth fails.
              // forceVerify: false skips consent screen if user already authorized these scopes.
              // SCOPE_RECOVERY cookie prevents infinite loop on 2nd callback.
              logger.info('Auth callback: Auto-redirecting to restore missing scopes', {
                twitchUserId: twitchUser.id,
                missingScopes,
                existingAdditional,
                tokenScopes: tokens.scope,
              })

              const newState = crypto.randomUUID()
              const redirectUri = `${baseUrl}/api/auth/twitch/callback`
              const authUrl = getTwitchAuthUrl(redirectUri, newState, existingAdditional, { forceVerify: false })

              const redirectResponse = NextResponse.redirect(authUrl)
              redirectResponse.cookies.set(COOKIE_NAMES.AUTH_STATE, newState, STATE_COOKIE_OPTIONS)
              redirectResponse.cookies.set(COOKIE_NAMES.SCOPE_RECOVERY, newState, STATE_COOKIE_OPTIONS)
              return redirectResponse
            }
          }
        }
      } catch (error) {
        // 予期しない例外: fail-safe(スキップ)。リダイレクトせずupsertに進む
        // Unexpected exception: fail-safe skip. Proceed to upsert without redirect.
        skipScopeSave = true
        logger.warn('Auth callback: Skipping scope save due to unexpected error', {
          twitchUserId: twitchUser.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    try {
      // #663: 書き込みのため isPgWriteEnabled() で分岐。pg 版（upsertAuthUserPg）は
      // 内部でログ出力後に throw するため、既存の「エラー時ログ＋throw」と同じ
      // 外部挙動になる。
      await upsertAuthUserPg({
        twitchUserId: twitchUser.id,
        twitchUsername: twitchUser.login,
        twitchDisplayName: twitchUser.display_name,
        twitchProfileImageUrl: twitchUser.profile_image_url,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAtIso: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      })

      // トークン交換時に付与されたスコープをDBに全置換で保存する。
      // loginルートがOAuthリクエストに既存スコープ（user:write:chat等）を含めるため、
      // ユーザーのTwitch Grantにスコープが存在すれば新トークンにも含まれ保持される。
      // トークンにないスコープをDBに残すとDB/トークン乖離が生じ401エラーの原因になるため、
      // マージではなく全置換を使用する。
      //
      // Save token scopes to DB using full replace.
      // The login route includes existing scopes in the OAuth request, so Twitch returns
      // any previously-granted additional scopes in the new token. Full replace keeps DB
      // in sync with actual token capabilities, preventing DB/token divergence that causes
      // repeated 401 errors (token lacks scope but DB says it has it).
      if (tokens.scope && tokens.scope.length > 0) {
        if (scopeRestoreFailed) {
          // ガード発動: login側でDB障害等によりスコープ復元に失敗しているため、
          // トークンに追加スコープが含まれていない可能性がある。全置換すると消失するのでスキップ
          logger.warn('Auth callback: Skipping scope save due to scope restoration failure in login', {
            twitchUserId: twitchUser.id,
            tokenScopes: tokens.scope,
          })
        } else if (skipScopeSave) {
          // DB読み取りエラー等のfail-safe: DB既存スコープを保護するためスキップ
          // Fail-safe for DB read errors: skip to protect existing DB scopes
          logger.warn('Auth callback: Scope save skipped due to fail-safe guard', {
            twitchUserId: twitchUser.id,
            tokenScopes: tokens.scope,
          })
        } else {
          await saveTwitchScopes(twitchUser.id, tokens.scope)
          logger.info('Auth callback: Saved Twitch scopes', {
            twitchUserId: twitchUser.id,
            scopeCount: tokens.scope.length,
            scopes: tokens.scope,
            isReauthFlow,
            isScopeRecovery,
          })
        }
      }
    } catch (error) {
      // エラー詳細をログ出力（wrangler tailで確認可能）
      // Log error details for debugging via wrangler tail
      logger.error('Auth callback: Database error details', {
        twitchUserId: twitchUser.id,
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
        errorCode: (error as { code?: string })?.code,
        errorDetails: (error as { details?: string })?.details,
        errorHint: (error as { hint?: string })?.hint,
      })
      return handleAuthError(
        error,
        'database_error',
        { operation: 'upsert_user', twitchUserId: twitchUser.id },
        { baseUrl }
      )
    }

    if (canBeStreamer) {
      try {
        // #663: 書き込みのため isPgWriteEnabled() で分岐。pg 版
        // （upsertAuthStreamerPg）は既存経路と同じく結果を確認しない
        // best-effort UPSERT として内部でエラーを握りつぶすため、この catch は
        // 両経路とも実質的に発火しない（postgrest 経路のコメント参照）。
        await upsertAuthStreamerPg({
          twitchUserId: twitchUser.id,
          twitchUsername: twitchUser.login,
          twitchDisplayName: twitchUser.display_name,
          twitchProfileImageUrl: twitchUser.profile_image_url,
        })
      } catch (error) {
        return handleAuthError(
          error,
          'database_error',
          { operation: 'upsert_streamer', twitchUserId: twitchUser.id },
          { baseUrl }
        )
      }
    }

    // #788 子C #791: channel_points_enabled フラグを独立読み取りし、セッションへミラーする。
    // users upsertには混ぜない（Critical-1、fetchChannelPointsEnabledFlagPgのdocコメント参照）。
    // あらゆる失敗（新列未適用の42703を含む）でfalseへフォールバックし、
    // ログイン自体は継続する。
    let channelPointsEnabled = false
    try {
      channelPointsEnabled = await fetchChannelPointsEnabledFlagPg(twitchUser.id)
    } catch (error) {
      logger.warn('Auth callback: Failed to read channel_points_enabled flag (falling back to false)', {
        twitchUserId: twitchUser.id,
        error: error instanceof Error ? error.message : String(error),
      })
      channelPointsEnabled = false
    }

    // #788 子C #791: step-up再認証直後（isReauthFlow）でChannel Pointsスコープを
    // 新たに取得した場合のみCapability Probeを自動実行する。毎ログインでは実行しない
    // （stale再判定の責務はアカウント設定UIの自動POSTに置く。Fable設計レビュー2回目 Major）。
    // definitiveな結果のみ保存し、ログイン自体は失敗させない。
    if (isReauthFlow && tokens.scope) {
      const hasChannelPointsScope =
        tokens.scope.includes(ADDITIONAL_SCOPES.CHANNEL_READ_REDEMPTIONS) ||
        tokens.scope.includes(ADDITIONAL_SCOPES.CHANNEL_MANAGE_REDEMPTIONS)
      if (hasChannelPointsScope) {
        try {
          const probeResult = await probeChannelPointsCapability(twitchUser.id)
          if (isDefinitiveCapabilityResult(probeResult)) {
            await persistChannelPointsCapability(twitchUser.id, probeResult)
          }
        } catch (error) {
          logger.warn('Auth callback: Channel Points capability probe failed (ignored, login continues)', {
            twitchUserId: twitchUser.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    // Set session cookie with user info only (no tokens - Supabase Auth handles tokens)
    const sessionData = JSON.stringify({
      twitchUserId: twitchUser.id,
      twitchUsername: twitchUser.login,
      twitchDisplayName: twitchUser.display_name,
      twitchProfileImageUrl: twitchUser.profile_image_url,
      broadcasterType: twitchUser.broadcaster_type,
      expiresAt: Date.now() + SESSION_CONFIG.MAX_AGE_MS,
      version: 1,
      channelPointsEnabled,
    })

    // Log session data size for debugging
    logger.info('Auth callback: Setting session cookie', {
      sessionDataLength: sessionData.length,
      cookieName: COOKIE_NAMES.SESSION,
      twitchUserId: twitchUser.id,
    })

    // ユーザーがTOS（利用規約）に同意済みかチェック
    // Check if user has accepted Terms of Service
    let hasTosAccepted = false
    try {
      // #663: 読み取り専用のため isPgReadEnabled() で分岐。既知の挙動差は
      // fetchTosAcceptedPg の doc コメント参照（pg 版はより安全側に倒れるのみ）。
      const userData = await fetchTosAcceptedPg(twitchUser.id)

      hasTosAccepted = userData?.tos_accepted_at !== null

      logger.info('Auth callback: TOS acceptance check', {
        twitchUserId: twitchUser.id,
        hasTosAccepted,
        tosAcceptedAt: userData?.tos_accepted_at,
      })
    } catch (error) {
      // TOS確認エラーの場合もログイン自体は続行、TOSページへリダイレクト
      // On TOS check error, continue with login but redirect to TOS page
      logger.warn('Auth callback: Failed to check TOS acceptance', {
        error,
        twitchUserId: twitchUser.id,
      })
    }

    // Check for returnTo cookie (saved before login redirect)
    // ログインリダイレクト前に保存されたreturnTo Cookieをチェック
    const returnTo = cookieStore.get(COOKIE_NAMES.RETURN_TO)?.value

    // Determine redirect URL:
    // 1. If TOS not accepted -> TOS page
    // 2. If returnTo cookie exists -> returnTo URL (if valid path starting with /)
    // 3. Default -> dashboard
    // リダイレクト先の決定:
    // 1. TOS未同意 -> TOSページ
    // 2. returnTo Cookieがある -> returnTo URL（/で始まる有効なパスの場合）
    // 3. デフォルト -> ダッシュボード
    let redirectUrl: string
    if (!hasTosAccepted) {
      redirectUrl = `${baseUrl}/tos`
    } else if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
      // Validate returnTo is a relative path (security: prevent open redirect)
      // returnToが相対パスであることを検証（セキュリティ: オープンリダイレクト防止）
      redirectUrl = `${baseUrl}${returnTo}`
    } else {
      redirectUrl = `${baseUrl}/dashboard`
    }

    logger.info('Auth callback: Redirecting with session cookie', {
      twitchUserId: twitchUser.id,
      redirectUrl,
      baseUrl,
    })

    // Create redirect response with cookies
    const response = NextResponse.redirect(redirectUrl)

    // セッションCookieを設定（統一されたドメイン設定を使用）
    const cookieOptions = getSessionCookieOptions()

    logger.info('Auth callback: Setting cookie with options', {
      domain: cookieOptions.domain,
      secure: cookieOptions.secure,
    })

    // セッションCookieにHMAC-SHA256署名を付与して改ざん検知を有効にする
    // Sign the session cookie with HMAC-SHA256 to enable tamper detection
    const signedSessionData = await signSession(sessionData)
    response.cookies.set(COOKIE_NAMES.SESSION, signedSessionData, cookieOptions)

    // Clear state cookie
    response.cookies.delete(COOKIE_NAMES.AUTH_STATE)

    // Clear scope restoration guard cookie only when state matches this flow
    // 並行ログイン（複数タブ）で別フローのガードを誤って消さないよう、
    // stateが一致するガードCookieのみ削除する
    // Only delete this flow's guard cookie to avoid removing another tab's guard
    if (scopeRestoreFailed) {
      response.cookies.set(COOKIE_NAMES.SCOPE_RESTORE_FAILED, '', getDeleteCookieOptions())
    }

    // Clear re-auth marker cookie only when state matches this flow
    // 並行フロー保護のため、state一致時のみ削除する
    if (isReauthFlow) {
      response.cookies.set(COOKIE_NAMES.REAUTH_STATE, '', getDeleteCookieOptions())
    }

    // Clear scope recovery marker cookie only when state matches this flow
    // スコープ自動復元リダイレクトのマーカーCookieを削除（state一致時のみ）
    if (isScopeRecovery) {
      response.cookies.set(COOKIE_NAMES.SCOPE_RECOVERY, '', getDeleteCookieOptions())
    }

    // スコープ復元用Cookie（ログアウト後のtwitchUserId保持用）を削除
    // 認証完了後はセッションCookieにtwitchUserIdが含まれるため不要
    // Delete scope restore cookie (kept after logout for twitchUserId scope restoration)
    // No longer needed once authenticated - twitchUserId is now in the session cookie
    response.cookies.set(COOKIE_NAMES.SCOPE_RESTORE_USER_ID, '', getDeleteCookieOptions())

    // Clear returnTo cookie if it was used
    // 使用されたreturnTo Cookieを削除
    if (returnTo) {
      response.cookies.set(COOKIE_NAMES.RETURN_TO, '', getDeleteCookieOptions())
    }

    // Log the Set-Cookie header for debugging
    const setCookieHeader = response.headers.get('Set-Cookie')
    logger.info('Auth callback: Set-Cookie header', {
      hasCookieHeader: !!setCookieHeader,
      cookieHeaderLength: setCookieHeader?.length || 0,
    })

    return response
  } catch (error) {
    return handleAuthError(error, 'unknown_error', undefined, { baseUrl })
  }
}
