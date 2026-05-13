import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'
import {
  buildStreamerChatAccessRows,
  type ChatAccessBotAccountRow,
  type ChatAccessSenderSettingRow,
  type ChatAccessStreamerRow,
  type ChatAccessUserScopeRow,
} from '../src/lib/chatAnnouncementAccess'

type Env = Record<string, string>

type RouteContext = {
  req: IncomingMessage
  res: ServerResponse
  client: SupabaseClient<Database>
  url: URL
  body: unknown
}

function stripKeyWhitespace(value: string | undefined): string | undefined {
  return value?.replace(/\s/g, '')
}

function isLoopback(remoteAddress: string | undefined): boolean {
  return !remoteAddress ||
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined

  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return undefined
  return JSON.parse(raw)
}

function getSupabaseClient(env: Env): SupabaseClient<Database> {
  const url = env.VITE_DASHBOARD_SUPABASE_URL?.trim()
  const key = stripKeyWhitespace(
    env.DASHBOARD_SUPABASE_SECRET_KEY ||
      env.DASHBOARD_SUPABASE_SERVICE_ROLE_KEY ||
      env.VITE_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY
  )

  if (!url || !key) {
    throw new Error(
      'Missing local admin Supabase credentials. Set VITE_DASHBOARD_SUPABASE_URL and DASHBOARD_SUPABASE_SECRET_KEY.'
    )
  }

  return createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

function requireObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object')
  }
  return body as Record<string, unknown>
}

function isMissingRelationError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'PGRST205'
}

async function fetchAllPaged(buildQuery: () => any): Promise<any[]> {
  const batchSize = 1000
  const rows: any[] = []

  for (let from = 0; ; from += batchSize) {
    const { data, error } = await buildQuery().range(from, from + batchSize - 1)
    if (error) throw error
    if (!data || data.length === 0) break

    rows.push(...data)
    if (data.length < batchSize) break
  }

  return rows
}

async function fetchUsersForTwitchIds(
  client: SupabaseClient<Database>,
  twitchIds: string[]
): Promise<ChatAccessUserScopeRow[]> {
  const rows: ChatAccessUserScopeRow[] = []
  const batchSize = 500

  for (let index = 0; index < twitchIds.length; index += batchSize) {
    const batch = twitchIds.slice(index, index + batchSize)
    const batchRows = await fetchAllPaged(() =>
      client
        .from('users')
        .select('twitch_user_id, twitch_scopes')
        .in('twitch_user_id', batch)
    )
    rows.push(...(batchRows as ChatAccessUserScopeRow[]))
  }

  return rows
}

async function listStreamerChatAccess(client: SupabaseClient<Database>) {
  const streamers = (await fetchAllPaged(() =>
    client
      .from('streamers')
      .select('id, twitch_user_id, chat_announcement_enabled')
      .order('created_at', { ascending: false })
  )) as ChatAccessStreamerRow[]

  const twitchIds = [...new Set(streamers.map((streamer) => streamer.twitch_user_id))]

  const [userScopes, senderSettings, botAccounts] = await Promise.all([
    fetchUsersForTwitchIds(client, twitchIds),
    fetchAllPaged(() =>
      client
        .from('streamer_chat_sender_settings')
        .select('streamer_id, sender_mode, custom_bot_account_id')
    ) as Promise<ChatAccessSenderSettingRow[]>,
    fetchAllPaged(() =>
      client
        .from('twitch_bot_accounts')
        .select('id, owner_type, streamer_id, status')
        .eq('status', 'active')
    ) as Promise<ChatAccessBotAccountRow[]>,
  ])

  return buildStreamerChatAccessRows({
    streamers,
    userScopes,
    senderSettings,
    botAccounts,
  })
}

async function listLicenses(client: SupabaseClient<Database>) {
  const { data, error } = await client
    .from('user_licenses')
    .select('*')
    .order('activated_at', { ascending: false })

  if (error) throw error

  const licenses = data || []
  const twitchIds = [...new Set(licenses.map((license) => license.twitch_user_id))]

  if (twitchIds.length === 0) return []

  const { data: users, error: usersError } = await client
    .from('users')
    .select('twitch_user_id, twitch_display_name')
    .in('twitch_user_id', twitchIds)

  if (usersError) throw usersError

  const userMap = new Map((users || []).map((user) => [user.twitch_user_id, user.twitch_display_name]))
  return licenses.map((license) => ({
    ...license,
    twitch_username: userMap.get(license.twitch_user_id) || license.twitch_user_id,
  }))
}

async function listAnnouncements(client: SupabaseClient<Database>) {
  const { data: announcements, error: annError } = await client
    .from('announcements')
    .select('*')
    .order('created_at', { ascending: false })

  if (annError) throw annError

  const { data: readCounts, error: readError } = await client
    .from('announcement_reads')
    .select('announcement_id')

  if (readError) throw readError

  const countMap = new Map<string, number>()
  ;(readCounts || []).forEach((record) => {
    countMap.set(record.announcement_id, (countMap.get(record.announcement_id) || 0) + 1)
  })

  return (announcements || []).map((announcement) => ({
    ...announcement,
    read_count: countMap.get(announcement.id) || 0,
  }))
}

async function getOverview(client: SupabaseClient<Database>) {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const [
    usersResult,
    streamersResult,
    cardsResult,
    todayGachaResult,
    weekGachaResult,
    monthGachaResult,
    recentGachaResult,
    recentBattlesResult,
  ] = await Promise.all([
    client.from('users').select('*', { count: 'exact', head: true }),
    client.from('streamers').select('*', { count: 'exact', head: true }),
    client.from('cards').select('*', { count: 'exact', head: true }),
    client
      .from('gacha_history')
      .select('*', { count: 'exact', head: true })
      .gte('redeemed_at', todayStart),
    client
      .from('gacha_history')
      .select('*', { count: 'exact', head: true })
      .gte('redeemed_at', weekStart),
    client
      .from('gacha_history')
      .select('*', { count: 'exact', head: true })
      .gte('redeemed_at', monthStart),
    client
      .from('gacha_history')
      .select('*, cards(*), streamers(*)')
      .order('redeemed_at', { ascending: false })
      .limit(10),
    client
      .from('battles')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  const requiredResults = [
    usersResult,
    streamersResult,
    cardsResult,
    todayGachaResult,
    weekGachaResult,
    monthGachaResult,
    recentGachaResult,
  ]

  for (const result of requiredResults) {
    if (result.error) throw result.error
  }

  if (recentBattlesResult.error && !isMissingRelationError(recentBattlesResult.error)) {
    throw recentBattlesResult.error
  }

  return {
    stats: {
      totalUsers: usersResult.count || 0,
      totalStreamers: streamersResult.count || 0,
      totalCards: cardsResult.count || 0,
      todayGacha: todayGachaResult.count || 0,
      weekGacha: weekGachaResult.count || 0,
      monthGacha: monthGachaResult.count || 0,
    },
    recentGacha: recentGachaResult.data || [],
    recentBattles: recentBattlesResult.error ? [] : recentBattlesResult.data || [],
  }
}

function announcementPayload(body: unknown) {
  const payload = requireObject(body)
  return {
    title: String(payload.title || '').trim(),
    body: String(payload.body || '').trim(),
    severity: payload.severity || 'info',
    is_published: !!payload.is_published,
    published_at: typeof payload.published_at === 'string' ? payload.published_at : null,
    expires_at: typeof payload.expires_at === 'string' ? payload.expires_at : null,
    updated_at: new Date().toISOString(),
  }
}

async function handleRoute(ctx: RouteContext): Promise<unknown> {
  const { client, req, url, body } = ctx
  const path = url.pathname.replace(/^\/__admin/, '')

  if (req.method === 'GET' && path === '/overview') {
    return getOverview(client)
  }

  if (req.method === 'GET' && path === '/streamer-chat-access') {
    return listStreamerChatAccess(client)
  }

  if (req.method === 'GET' && path === '/support-codes') {
    const { data, error } = await client
      .from('support_codes')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data || []
  }

  if (req.method === 'POST' && path === '/support-codes') {
    const payload = requireObject(body)
    const { data, error } = await client
      .from('support_codes')
      .insert({
        code_hash: String(payload.code_hash || ''),
        plan_type: payload.plan_type,
        status: 'active',
        memo: payload.memo || null,
      } as never)
      .select()
      .single()
    if (error) throw error
    return data
  }

  const supportCodeMatch = path.match(/^\/support-codes\/([^/]+)$/)
  if (req.method === 'PATCH' && supportCodeMatch) {
    const payload = requireObject(body)
    const { data, error } = await client
      .from('support_codes')
      .update({ status: payload.status, updated_at: new Date().toISOString() } as never)
      .eq('id', supportCodeMatch[1])
      .select()
      .single()
    if (error) throw error
    return data
  }

  const revokeMatch = path.match(/^\/support-codes\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    const { error } = await client.rpc('revoke_support_code' as never, {
      p_code_id: revokeMatch[1],
    } as never)
    if (error) throw error
    return { ok: true }
  }

  if (req.method === 'GET' && path === '/licenses') {
    return listLicenses(client)
  }

  if (req.method === 'GET' && path === '/twitch-subs') {
    const { data, count, error } = await client
      .from('users')
      .select('twitch_user_id, twitch_display_name, twitch_sub_verified_at', { count: 'exact' })
      .eq('twitch_has_sub', true)
      .order('twitch_sub_verified_at', { ascending: false })
    if (error) throw error
    return { rows: data || [], count: count || 0 }
  }

  if (req.method === 'GET' && path === '/support-inquiries') {
    const status = url.searchParams.get('status') || 'all'
    let query = client
      .from('support_inquiries')
      .select('*')
      .order('created_at', { ascending: false })

    if (status !== 'all') {
      query = query.eq('status', status)
    }

    const { data, error } = await query
    if (error) throw error
    return data || []
  }

  if (req.method === 'GET' && path === '/announcements') {
    return listAnnouncements(client)
  }

  if (req.method === 'POST' && path === '/announcements') {
    const payload = announcementPayload(body)
    const { data, error } = await client
      .from('announcements')
      .insert(payload as never)
      .select()
      .single()
    if (error) throw error
    return {
      ...data,
      read_count: 0,
    }
  }

  const announcementMatch = path.match(/^\/announcements\/([^/]+)$/)
  if (announcementMatch && req.method === 'PATCH') {
    const payload = requireObject(body)
    const update = 'title' in payload || 'body' in payload || 'severity' in payload
      ? announcementPayload(body)
      : {
          is_published: !!payload.is_published,
          updated_at: new Date().toISOString(),
        }

    const { data, error } = await client
      .from('announcements')
      .update(update as never)
      .eq('id', announcementMatch[1])
      .select()
      .single()
    if (error) throw error

    const { count, error: countError } = await client
      .from('announcement_reads')
      .select('id', { count: 'exact', head: true })
      .eq('announcement_id', announcementMatch[1])
    if (countError) throw countError

    return {
      ...data,
      read_count: count || 0,
    }
  }

  if (announcementMatch && req.method === 'DELETE') {
    const { error } = await client
      .from('announcements')
      .delete()
      .eq('id', announcementMatch[1])
    if (error) throw error
    return { ok: true }
  }

  const inquiryMatch = path.match(/^\/support-inquiries\/([^/]+)$/)
  if (req.method === 'PATCH' && inquiryMatch) {
    const payload = requireObject(body)
    const { data, error } = await client
      .from('support_inquiries')
      .update({ status: payload.status, updated_at: new Date().toISOString() } as never)
      .eq('id', inquiryMatch[1])
      .select()
      .single()
    if (error) throw error
    return data
  }

  const messagesMatch = path.match(/^\/support-inquiries\/([^/]+)\/messages$/)
  if (messagesMatch && req.method === 'GET') {
    const { data, error } = await client
      .from('support_inquiry_messages')
      .select('*')
      .eq('inquiry_id', messagesMatch[1])
      .order('created_at', { ascending: true })
    if (error) throw error
    return data || []
  }

  if (messagesMatch && req.method === 'POST') {
    const payload = requireObject(body)
    const { data, error } = await client
      .from('support_inquiry_messages')
      .insert({
        inquiry_id: messagesMatch[1],
        sender_type: 'admin',
        sender_id: 'admin',
        body: String(payload.body || '').trim(),
      } as never)
      .select()
      .single()
    if (error) throw error
    return data
  }

  throw Object.assign(new Error('Admin API route not found'), { statusCode: 404 })
}

export function localAdminApiPlugin(env: Env): Plugin {
  let client: SupabaseClient<Database> | null = null

  return {
    name: 'twica-local-admin-api',
    configureServer(server) {
      server.middlewares.use('/__admin', async (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
          sendJson(res, 403, { error: 'Admin API is only available from loopback addresses' })
          return
        }

        try {
          client ||= getSupabaseClient(env)
          const body = await readBody(req)
          const result = await handleRoute({
            req,
            res,
            client,
            body,
            url: new URL(req.url || '/', 'http://localhost'),
          })
          sendJson(res, 200, result)
        } catch (error) {
          const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
            ? (error as { statusCode: number }).statusCode
            : 500
          console.error('[local-admin-api]', error)
          sendJson(res, status, {
            error: error instanceof Error ? error.message : 'Admin API request failed',
          })
        }
      })
    },
  }
}
