import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCodeForTokens, getTwitchUser, ADDITIONAL_SCOPES } from '@/lib/twitch/auth'
import { saveTwitchScopes } from '@/lib/twitch/token-manager'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { handleAuthError } from '@/lib/auth-error-handler'
import { COOKIE_NAMES, SESSION_CONFIG, ERROR_MESSAGES, getSessionCookieOptions, getDeleteCookieOptions } from '@/lib/constants'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getBaseUrl } from '@/lib/url-utils'

export async function GET(request: NextRequest) {
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
  const storedState = cookieStore.get('twitch_auth_state')?.value

  if (!storedState || state !== storedState) {
    return handleAuthError(
      new Error('Invalid state parameter'),
      'invalid_state',
      { storedState: !!storedState, stateMatch: storedState === state },
      { baseUrl }
    )
  }

  try {
    const supabaseAdmin = getSupabaseAdmin()
    // Twitchへのトークン交換リクエストでは、元のリダイレクトURIと一致する必要がある
    const redirectUri = `${baseUrl}/api/auth/twitch/callback`
    
    let tokens
    try {
      tokens = await exchangeCodeForTokens(code, redirectUri)
    } catch (error) {
      return handleAuthError(
        error,
        'twitch_auth_failed',
        { code: code.substring(0, 10) + '...' },
        { baseUrl }
      )
    }

    let twitchUser
    try {
      twitchUser = await getTwitchUser(tokens.access_token)
    } catch (error) {
      return handleAuthError(
        error,
        'twitch_user_fetch_failed',
        { twitchUserId: tokens.access_token.substring(0, 10) + '...' },
        { baseUrl }
      )
    }

    // Check if user can be a streamer (affiliate or partner)
    const canBeStreamer = twitchUser.broadcaster_type === 'affiliate' || twitchUser.broadcaster_type === 'partner'

    // スコープ復元ガードCookieを確認（login側でDB障害等によりスコープ復元に失敗した場合に設定される）
    // Check scope restoration guard cookie (set by login route when scope restoration fails)
    const scopeRestoreFailedState = cookieStore.get(COOKIE_NAMES.SCOPE_RESTORE_FAILED)?.value
    const scopeRestoreFailed = scopeRestoreFailedState === state
    // 再認証フロー判定Cookie（reauth APIで設定）
    // Re-auth flow marker cookie (set by reauth API)
    const reauthState = cookieStore.get(COOKIE_NAMES.REAUTH_STATE)?.value
    const isReauthFlow = reauthState === state

    try {
      // upsertのエラーを明示的にチェック（Supabase JSはエラー時にthrowせずerrorオブジェクトを返す）
      // Explicitly check upsert error (Supabase JS returns error object instead of throwing)
      const { error: upsertError } = await supabaseAdmin
        .from('users')
        .upsert({
          twitch_user_id: twitchUser.id,
          twitch_username: twitchUser.login,
          twitch_display_name: twitchUser.display_name,
          twitch_profile_image_url: twitchUser.profile_image_url,
          twitch_access_token: tokens.access_token,
          twitch_refresh_token: tokens.refresh_token,
          twitch_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        }, {
          onConflict: 'twitch_user_id',
        })

      if (upsertError) {
        logger.error('Auth callback: User upsert failed', {
          twitchUserId: twitchUser.id,
          error: upsertError,
          code: upsertError.code,
          message: upsertError.message,
          details: upsertError.details,
          hint: upsertError.hint,
        })
        throw upsertError
      }

      // 通常ログイン時のみ既存追加スコープを取得してマージに利用する。
      // 再認証フローはユーザーの明示同意結果を反映するため、マージせず全置換する。
      // For regular login only, fetch existing additional scopes for merge.
      // Re-auth flow must reflect explicit user consent, so keep full replace.
      let existingAdditionalScopes: string[] = []
      if (!isReauthFlow) {
        const { data: existingUser, error: existingScopeError } = await supabaseAdmin
          .from('users')
          .select('twitch_scopes')
          .eq('twitch_user_id', twitchUser.id)
          .maybeSingle()

        if (existingScopeError && existingScopeError.code !== 'PGRST204') {
          logger.error('Auth callback: Failed to fetch existing scopes for merge', {
            twitchUserId: twitchUser.id,
            error: existingScopeError,
            code: existingScopeError.code,
            message: existingScopeError.message,
          })
          throw existingScopeError
        }

        if (existingUser?.twitch_scopes) {
          const validAdditionalScopes = Object.values(ADDITIONAL_SCOPES) as string[]
          existingAdditionalScopes = existingUser.twitch_scopes.filter(
            (s: string) => validAdditionalScopes.includes(s)
          )
        }
      }

      // トークン交換時に付与されたスコープをDBに保存。
      // 通常ログイン時は既存の追加スコープをマージし、ログアウト後ログインでも追加権限を保持する。
      // ただしlogin側でスコープ復元に失敗していた場合は更新をスキップして既存DBを保持。
      // Save token scopes to DB.
      // On regular login, merge with existing additional scopes so relogin after logout
      // does not drop previously granted optional permissions.
      // If login-side scope restoration failed, skip update to preserve DB state.
      if (tokens.scope && tokens.scope.length > 0) {
        if (scopeRestoreFailed) {
          // ガード発動: login側でDB障害等によりスコープ復元に失敗しているため、
          // トークンに追加スコープが含まれていない可能性がある。全置換すると消失するのでスキップ
          // Guard triggered: scope restoration failed in login route,
          // token may be missing additional scopes. Skip full-replace to preserve DB state
          logger.warn('Auth callback: Skipping scope save due to scope restoration failure in login', {
            twitchUserId: twitchUser.id,
            tokenScopes: tokens.scope,
          })
        } else {
          let scopesToSave = tokens.scope

          if (!isReauthFlow && existingAdditionalScopes.length > 0) {
            scopesToSave = Array.from(new Set([...tokens.scope, ...existingAdditionalScopes]))
            logger.info('Auth callback: Merged existing additional scopes on regular login', {
              twitchUserId: twitchUser.id,
              tokenScopes: tokens.scope,
              existingAdditionalScopes,
              mergedScopes: scopesToSave,
            })
          }

          await saveTwitchScopes(twitchUser.id, scopesToSave)
          logger.info('Auth callback: Saved Twitch scopes', {
            twitchUserId: twitchUser.id,
            scopeCount: scopesToSave.length,
            scopes: scopesToSave,
            isReauthFlow,
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
        await supabaseAdmin
          .from('streamers')
          .upsert({
            twitch_user_id: twitchUser.id,
            twitch_username: twitchUser.login,
            twitch_display_name: twitchUser.display_name,
            twitch_profile_image_url: twitchUser.profile_image_url,
          }, {
            onConflict: 'twitch_user_id',
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

    // Set session cookie with user info only (no tokens - Supabase Auth handles tokens)
    const sessionData = JSON.stringify({
      twitchUserId: twitchUser.id,
      twitchUsername: twitchUser.login,
      twitchDisplayName: twitchUser.display_name,
      twitchProfileImageUrl: twitchUser.profile_image_url,
      broadcasterType: twitchUser.broadcaster_type,
      expiresAt: Date.now() + SESSION_CONFIG.MAX_AGE_MS,
      version: 1,
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
      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('tos_accepted_at')
        .eq('twitch_user_id', twitchUser.id)
        .maybeSingle()

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

    response.cookies.set(COOKIE_NAMES.SESSION, sessionData, cookieOptions)

    // Clear state cookie
    response.cookies.delete('twitch_auth_state')

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
