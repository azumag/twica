import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCodeForTokens, getTwitchUser, isInvalidAuthorizationCodeError, getTwitchAuthUrl } from '@/lib/twitch/auth'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { saveTwitchScopes } from '@/lib/twitch/token-manager'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { handleAuthError } from '@/lib/auth-error-handler'
import { COOKIE_NAMES, SESSION_CONFIG, ERROR_MESSAGES, getSessionCookieOptions, getDeleteCookieOptions, STATE_COOKIE_OPTIONS } from '@/lib/constants'
import { checkRateLimit, rateLimits, getClientIp } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getBaseUrl } from '@/lib/url-utils'
import { signSession } from '@/lib/session'
import { handleLinkedAccountCallback } from '@/lib/twitch/linked-account-auth'
// -----------------------------------------------------------------------------
// #663 (#570/#572 パターン踏襲): pg 直結経路。
// このルートは users / streamers への upsert（書き込み）と読み取り（スコープ乖離
// チェック・TOS 確認）が混在するため、ルート内の DB アクセス全体を
// isPgWriteEnabled() で分岐する（読み書きで経路が混ざると障害切り分けが困難になる
// ため。sub-check.ts 冒頭コメント参照。pg-read モードでは本ルートは従来の PostgREST
// 経路のまま動く）。既存 supabase-js 実装は無変更で残し（else 節への再インデント
// のみ）、フラグ未設定時は完全に従来どおり動く。
// 共有関数 saveTwitchScopes の内部では独立にフラグ分岐される。
// -----------------------------------------------------------------------------
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { isPgWriteEnabled } from '@/lib/db/flags'
import { withDbRetry } from '@/lib/db/retry'
import { streamers as streamersTable, users as usersTable } from '@/lib/db/schema'

/**
 * スコープ乖離チェック用の users.twitch_scopes 取得の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - users.twitch_user_id は UNIQUE（migration 00001）のため最大 1 行。
 *   .maybeSingle() は LIMIT 1 + rows[0] ?? null で同じ外部挙動（0 行はエラーではなく null）。
 * - twitch_scopes は text[] 列のため必ず Drizzle スキーマ経由で読む
 *   （src/lib/db/client.ts の fetch_types: false の注意書き参照）。
 * - エラーは throw のまま伝播させ、ハンドラ側で既存経路の existingScopeError 分岐
 *   （fail-safe の skipScopeSave）と同じ外部挙動に落とす。
 */
async function fetchExistingUserScopesPg(
  twitchUserId: string
): Promise<{ twitch_scopes: string[] | null } | null> {
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
    'authCallback(existing scopes)',
    // 読み取り専用クエリのため冪等（リトライ可）
    { idempotent: true },
  )
  return rows[0] ?? null
}

/**
 * users への upsert の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - supabase-js の .upsert(values, { onConflict: 'twitch_user_id' }) は
 *   INSERT ... ON CONFLICT (twitch_user_id) DO UPDATE SET（送信した全列を
 *   EXCLUDED の値で上書き）に相当する。twitch_user_id は users の UNIQUE 制約
 *   （migration 00001）が conflict target。Drizzle の .onConflictDoUpdate({ target,
 *   set: values }) は同じ列に同じ値を書くため意味論が一致する（conflict target 列
 *   自体への set は同値の no-op で、PostgREST も payload に含めて送る挙動と同じ）。
 * - updated_at は両経路とも payload に含めない（DB 側の挙動が経路によらず共通）。
 * - エラーは throw のまま伝播させ、ハンドラ側で既存経路と同じ「log + throw →
 *   database_error 応答」の流れに合わせる。
 *
 * 冪等性: values は呼び出し元で事前計算済み（expires_at の ISO 文字列を含む）で、
 * ON CONFLICT DO UPDATE はリトライしても同じ最終状態になるため idempotent: true
 * （linked-account-auth.ts の sender settings upsert と同じ判断）。
 */
async function upsertUserPg(values: {
  twitch_user_id: string
  twitch_username: string
  twitch_display_name: string
  twitch_profile_image_url: string | null
  twitch_access_token: string
  twitch_refresh_token: string
  twitch_token_expires_at: string
}): Promise<void> {
  await withDbRetry(
    async () => {
      const { db } = await getDb()
      return db
        .insert(usersTable)
        .values(values)
        .onConflictDoUpdate({
          target: usersTable.twitch_user_id,
          set: values,
        })
    },
    'authCallback(users upsert)',
    { idempotent: true },
  )
}

/**
 * streamers への upsert の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - conflict target は streamers.twitch_user_id の UNIQUE 制約（migration 00001）。
 *   意味論の対応は upsertUserPg のコメント参照。
 * - エラー処理はハンドラ側（呼び出し元のコメント参照）。
 *
 * 冪等性: values は事前計算済みの ON CONFLICT DO UPDATE のため idempotent: true。
 */
async function upsertStreamerPg(values: {
  twitch_user_id: string
  twitch_username: string
  twitch_display_name: string
  twitch_profile_image_url: string | null
}): Promise<void> {
  await withDbRetry(
    async () => {
      const { db } = await getDb()
      return db
        .insert(streamersTable)
        .values(values)
        .onConflictDoUpdate({
          target: streamersTable.twitch_user_id,
          set: values,
        })
    },
    'authCallback(streamers upsert)',
    { idempotent: true },
  )
}

/**
 * TOS 同意確認用の users.tos_accepted_at 取得の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - .maybeSingle() は users.twitch_user_id の UNIQUE 制約（migration 00001）により
 *   LIMIT 1 + rows[0] ?? null で同じ外部挙動。
 * - tos_accepted_at は timestamptz。pg 直結は PG テキスト形式の文字列で返る
 *   （PostgREST は ISO 8601）が、消費側は「null かどうか」の判定とログ出力のみで
 *   文字列のパース・表示は行わないため表現差の影響はない。
 * - エラーは throw のまま伝播させ、ハンドラ側で「data=null 扱い」（既存経路は
 *   .maybeSingle() の error を確認しない）と同じ外部挙動に落とす。
 */
async function fetchTosAcceptedAtPg(
  twitchUserId: string
): Promise<{ tos_accepted_at: string | null } | null> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb()
      return db
        .select({ tos_accepted_at: usersTable.tos_accepted_at })
        .from(usersTable)
        .where(eq(usersTable.twitch_user_id, twitchUserId))
        .limit(1)
    },
    'authCallback(tos check)',
    // 読み取り専用クエリのため冪等（リトライ可）
    { idempotent: true },
  )
  return rows[0] ?? null
}

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
    // #663: 読み書き混在ルートのため、DB アクセス全体を isPgWriteEnabled() で分岐する
    // （ファイル冒頭コメント参照）。リクエスト途中で経路が揺れないよう 1 回だけ評価する。
    // supabaseAdmin のクライアント生成自体は I/O を伴わないため、既存コードの位置の
    // まま無変更で残す（pg 経路では以降の else 節でのみ使用される）。
    const usePgWrite = isPgWriteEnabled()
    const supabaseAdmin = getSupabaseAdmin()
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
        // #663: 既存スコープの読み取りのみ経路分岐する。読み取り失敗時はどちらの
        // 経路も existingUser=null のまま skipScopeSave=true（fail-safe）となり、
        // 後段の乖離チェック（両経路共有・既存ロジック無変更）に到達しない。
        let existingUser: { twitch_scopes: string[] | null } | null = null
        if (usePgWrite) {
          try {
            existingUser = await fetchExistingUserScopesPg(twitchUser.id)
          } catch (existingScopeError) {
            // 既存経路の existingScopeError 分岐と同じ fail-safe（スキップ）
            skipScopeSave = true
            logger.warn('Auth callback: Skipping scope save due to existing scope read failure', {
              twitchUserId: twitchUser.id,
              error:
                existingScopeError instanceof Error
                  ? existingScopeError.message
                  : String(existingScopeError),
            })
          }
        } else {
          const { data, error: existingScopeError } = await supabaseAdmin
            .from('users')
            .select('twitch_scopes')
            .eq('twitch_user_id', twitchUser.id)
            .maybeSingle()

          if (existingScopeError) {
            // DB読み取り失敗: fail-safe(スキップ)で保護。リダイレクトできない（スコープ不明）
            // DB read failure: fail-safe skip. Cannot redirect (unknown scopes).
            skipScopeSave = true
            logger.warn('Auth callback: Skipping scope save due to existing scope read failure', {
              twitchUserId: twitchUser.id,
              error: existingScopeError.message,
            })
          } else {
            existingUser = data
          }
        }

        if (existingUser?.twitch_scopes) {
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
      if (usePgWrite) {
        // pg 直結: 失敗（throw）時は既存経路の「upsertError を log + throw」と同じく、
        // この try の catch（database_error 応答）へ伝播させる。
        try {
          await upsertUserPg({
            twitch_user_id: twitchUser.id,
            twitch_username: twitchUser.login,
            twitch_display_name: twitchUser.display_name,
            twitch_profile_image_url: twitchUser.profile_image_url,
            twitch_access_token: tokens.access_token,
            twitch_refresh_token: tokens.refresh_token,
            // withDbRetry の queryFn 再実行時にも同じ値を書くよう、ここで 1 度だけ計算
            // した値を渡す（upsertUserPg の冪等性コメント参照）
            twitch_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          })
        } catch (upsertError) {
          // details / hint は PostgREST 応答固有のフィールドのため pg 直結には無い
          // （ログ内容の差のみで外部挙動は同一）
          logger.error('Auth callback: User upsert failed', {
            twitchUserId: twitchUser.id,
            error: upsertError,
            code: (upsertError as { code?: string })?.code,
            message: upsertError instanceof Error ? upsertError.message : String(upsertError),
          })
          throw upsertError
        }
      } else {
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
      }

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
      if (usePgWrite) {
        try {
          await upsertStreamerPg({
            twitch_user_id: twitchUser.id,
            twitch_username: twitchUser.login,
            twitch_display_name: twitchUser.display_name,
            twitch_profile_image_url: twitchUser.profile_image_url,
          })
        } catch (streamerUpsertError) {
          // パリティ上の重要判断: 既存 postgrest 経路は .upsert() の error オブジェクトを
          // 確認していない（supabase-js は DB エラーで throw せず error を返すため、
          // 下の catch は実質デッドコードで、streamers upsert の DB エラーはログイン
          // 継続を妨げない）。pg 直結では失敗が throw になるため、ここで握りつぶして
          // 「streamers upsert が失敗してもログインは成功する」同じ外部挙動に合わせる。
          // ここで database_error を返すと、一時的な DB エラーでログイン全体が失敗する
          // 挙動変更（ユーザー影響のある回帰）になってしまう。切替検証用に warn を残す。
          logger.warn('Auth callback: streamers upsert failed (login continues; postgrest parity)', {
            twitchUserId: twitchUser.id,
            error:
              streamerUpsertError instanceof Error
                ? streamerUpsertError.message
                : String(streamerUpsertError),
            code: (streamerUpsertError as { code?: string })?.code,
          })
        }
      } else {
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
      // #663: TOS 確認の読み取りのみ経路分岐する。判定・ログは両経路で共有（無変更）。
      let userData: { tos_accepted_at: string | null } | null
      if (usePgWrite) {
        try {
          userData = await fetchTosAcceptedAtPg(twitchUser.id)
        } catch {
          // 既存 postgrest 経路は .maybeSingle() の error を確認しない（エラー時は
          // data=null → 下の判定が「undefined !== null = true」となり TOS ページへ
          // 飛ばさずログインを継続する）。pg 直結の throw も null に落として同じ
          // 外部挙動にする（ここで外側 catch に伝播させると hasTosAccepted=false の
          // まま TOS ページへ飛ぶ、経路による挙動差が生じてしまう）。
          userData = null
        }
      } else {
        const { data } = await supabaseAdmin
          .from('users')
          .select('tos_accepted_at')
          .eq('twitch_user_id', twitchUser.id)
          .maybeSingle()
        userData = data
      }

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
