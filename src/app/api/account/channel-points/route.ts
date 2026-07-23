import { NextRequest, NextResponse } from 'next/server'
import { getSession, signSession } from '@/lib/session'
import { validateCSRFToken } from '@/lib/csrf'
import { validateContentType } from '@/lib/request-validation'
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from '@/lib/rate-limit'
import { handleApiError } from '@/lib/error-handler'
import { BROADCASTER_TYPE, COOKIE_NAMES, ERROR_MESSAGES, getSessionCookieOptions } from '@/lib/constants'
import { ADDITIONAL_SCOPES } from '@/lib/twitch/scopes'
import { hasScope } from '@/lib/twitch/token-manager'
import {
  isDefinitiveCapabilityResult,
  probeChannelPointsCapability,
  type DefinitiveCapabilityResult,
} from '@/lib/twitch/channel-points'
import {
  enableChannelPointsStreamerAccess,
  getChannelPointsAccessState,
  persistChannelPointsCapability,
} from '@/lib/twitch/channel-points-access'
import { logger } from '@/lib/logger'

// #788 子C #791: 保存済みcapability確認が「stale」とみなされる猶予期間。
// これを超えたら/dashboard/accountの初回表示時にUIが自動で再判定(POST)する。
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000

async function hasChannelPointsScope(twitchUserId: string): Promise<boolean> {
  const [hasRead, hasManage] = await Promise.all([
    hasScope(twitchUserId, ADDITIONAL_SCOPES.CHANNEL_READ_REDEMPTIONS),
    hasScope(twitchUserId, ADDITIONAL_SCOPES.CHANNEL_MANAGE_REDEMPTIONS),
  ])
  return hasRead || hasManage
}

function isStale(capability: string, checkedAt: string | null): boolean {
  if (capability === 'unknown' || !checkedAt) return true
  const checkedAtMs = new Date(checkedAt).getTime()
  if (Number.isNaN(checkedAtMs)) return true
  return Date.now() - checkedAtMs > STALE_THRESHOLD_MS
}

/**
 * スコープ不足を検出した際に、確定状態としてreauth_requiredを保存する共通処理。
 * 永続化自体の失敗はレスポンスを巻き込まない（warnログのみ）。
 */
async function persistReauthRequired(twitchUserId: string): Promise<void> {
  const result: DefinitiveCapabilityResult = {
    capability: 'reauth_required',
    reason: 'no_access_token',
    definitive: true,
  }
  try {
    await persistChannelPointsCapability(twitchUserId, result)
  } catch (error) {
    logger.warn('Account Channel Points API: failed to persist reauth_required (missing scope)', {
      twitchUserId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * GET: 副作用なしで保存済みCapability/オプトイン状態と付随情報を返す (#791)。
 * 認証済みsession必須。canEnableはbroadcasterTypeが空・capabilityがavailable・
 * 未有効化の場合のみtrueになる（Affiliate/Partnerは対象外）。
 */
export async function GET() {
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    const [state, hasRequiredScope] = await Promise.all([
      getChannelPointsAccessState(session.twitchUserId),
      hasChannelPointsScope(session.twitchUserId),
    ])

    const capability = state?.capability ?? 'unknown'
    const capabilityCheckedAt = state?.checkedAt ?? null
    const enabled = state?.enabled === true
    const requiresReauth = !hasRequiredScope || capability === 'reauth_required'
    const stale = isStale(capability, capabilityCheckedAt)
    const canEnable = session.broadcasterType === BROADCASTER_TYPE.NONE && capability === 'available' && !enabled

    return NextResponse.json({
      broadcasterType: session.broadcasterType,
      capability,
      capabilityCheckedAt,
      enabled,
      hasRequiredScope,
      requiresReauth,
      stale,
      canEnable,
    })
  } catch (error) {
    return handleApiError(error, 'Account Channel Points API: GET')
  }
}

/**
 * POST: 明示的な「確認」「再判定」。scope不足ならreauth_requiredを確定保存して返す。
 * scopeがあればCapability Probeを実行し、definitiveな結果のみDBへ保存する。
 * 429/5xx/network error等（definitive=false）は保存済みの確定状態を破壊しない。
 */
export async function POST(request: NextRequest) {
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) return contentTypeValidation

  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
  }

  try {
    const session = await getSession()
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.accountChannelPointsProbe, identifier)
    if (!rateLimitResult.success) {
      return NextResponse.json({ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED }, { status: 429 })
    }

    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    if (!(await hasChannelPointsScope(session.twitchUserId))) {
      await persistReauthRequired(session.twitchUserId)
      const state = await getChannelPointsAccessState(session.twitchUserId)
      return NextResponse.json({
        code: 'reauth_required',
        probe: { capability: 'reauth_required', reason: 'no_access_token', definitive: true },
        persisted: state ? { capability: state.capability, capabilityCheckedAt: state.checkedAt } : null,
        enabled: state?.enabled === true,
      })
    }

    const probeResult = await probeChannelPointsCapability(session.twitchUserId)
    if (isDefinitiveCapabilityResult(probeResult)) {
      await persistChannelPointsCapability(session.twitchUserId, probeResult)
    }
    const state = await getChannelPointsAccessState(session.twitchUserId)

    return NextResponse.json({
      code: probeResult.definitive ? probeResult.capability : 'probe_temporarily_failed',
      probe: probeResult,
      persisted: state ? { capability: state.capability, capabilityCheckedAt: state.checkedAt } : null,
      enabled: state?.enabled === true,
    })
  } catch (error) {
    return handleApiError(error, 'Account Channel Points API: POST')
  }
}

/**
 * PUT: 明示的有効化。対象は常にsession本人（bodyから任意のIDを受け付けない）。
 * Affiliate/Partnerはidempotent success（DB flagは不要にtrue化しない）。
 * 保存済みavailableを信用せず、必ず新規Probeを実行してから有効化する。
 * DB更新（RPC）に成功した場合のみsession cookieを再署名する。
 */
export async function PUT(request: NextRequest) {
  // このrouteはbodyを使用しない（有効化対象は常にsession本人）ため、
  // Content-Type検証は行わない（cards/[id]のPUTと同じ判断）。
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 })
  }

  try {
    const session = await getSession()
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId)
    const rateLimitResult = await checkRateLimit(rateLimits.accountChannelPointsProbe, identifier)
    if (!rateLimitResult.success) {
      return NextResponse.json({ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED }, { status: 429 })
    }

    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 })
    }

    // Affiliate/Partnerは既存アクセス経路を持つため有効化対象ではない。
    // idempotent successとして返し、DB flagを不要にtrue化しない。
    if (session.broadcasterType === BROADCASTER_TYPE.AFFILIATE || session.broadcasterType === BROADCASTER_TYPE.PARTNER) {
      return NextResponse.json({ code: 'already_enabled', enabled: true })
    }

    if (!(await hasChannelPointsScope(session.twitchUserId))) {
      await persistReauthRequired(session.twitchUserId)
      return NextResponse.json({ code: 'reauth_required', enabled: false }, { status: 409 })
    }

    // 保存済みのavailableを信用せず、必ず新しいProbeで再検証する。
    const probeResult = await probeChannelPointsCapability(session.twitchUserId)
    if (isDefinitiveCapabilityResult(probeResult)) {
      await persistChannelPointsCapability(session.twitchUserId, probeResult)
    }

    if (probeResult.capability !== 'available') {
      const code =
        probeResult.capability === 'reauth_required'
          ? 'reauth_required'
          : probeResult.capability === 'unavailable'
            ? 'channel_points_unavailable'
            : 'probe_temporarily_failed'
      return NextResponse.json({ code, enabled: false, probe: probeResult }, { status: 409 })
    }

    const enableResult = await enableChannelPointsStreamerAccess(session.twitchUserId)
    if (!enableResult.ok) {
      const code = enableResult.error === 'capability_not_available' ? 'channel_points_unavailable' : 'user_not_found'
      return NextResponse.json({ code, enabled: false }, { status: 409 })
    }

    // DB更新は成功済み。ここから先はsession cookieの再署名のみで、
    // 失敗してもDBをtrueから巻き戻さない（次回ログインでsession mirrorが復元される）。
    try {
      const updatedSessionPayload = {
        ...session,
        channelPointsEnabled: true,
        version: session.version + 1,
      }
      const signedSession = await signSession(JSON.stringify(updatedSessionPayload))
      const response = NextResponse.json({
        code: 'enabled',
        enabled: true,
        streamerId: enableResult.streamerId,
      })
      response.cookies.set(COOKIE_NAMES.SESSION, signedSession, getSessionCookieOptions())
      return response
    } catch (error) {
      logger.error('Account Channel Points API: DB enabled but session re-sign failed', {
        twitchUserId: session.twitchUserId,
        streamerId: enableResult.streamerId,
        error: error instanceof Error ? error.message : String(error),
      })
      return NextResponse.json(
        {
          code: 'session_resync_failed',
          enabled: true,
          error: 'Enabled successfully, but failed to refresh your session. Please retry or log in again.',
        },
        { status: 500 }
      )
    }
  } catch (error) {
    return handleApiError(error, 'Account Channel Points API: PUT')
  }
}
