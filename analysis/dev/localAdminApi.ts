import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Card, Database, Streamer } from '../src/types/database'
import {
  buildStreamerChatAccessRows,
  type ChatAccessBotAccountRow,
  type ChatAccessSenderSettingRow,
  type ChatAccessStreamerRow,
  type ChatAccessUserScopeRow,
} from '../src/lib/chatAnnouncementAccess'

type Env = Record<string, string>

type TimeRange = '7d' | '30d' | '90d' | 'all'

type GachaChartCard = Pick<Card, 'id' | 'name' | 'rarity' | 'image_url'>

interface GachaChartRow {
  id: string
  redeemed_at: string
  card_id: string
  user_twitch_id: string
  streamer_id: string
  cards: GachaChartCard | null
  streamers: Streamer | null
}

// 投票キャンペーンの識別子（2026選挙応援キャンペーン）
// analysis/src/pages/Streamers.tsx の同名定数と揃える。
// キャンペーン終了後はこの定数とクエリを削除すること
const VOTE_CAMPAIGN_TYPE = 'campaign' as const
const VOTE_CAMPAIGN_MEMO = '2026選挙応援' as const

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

// CSVフィールドの最小限の正しいエスケープ（RFC4180）:
// カンマ・ダブルクォート・改行(\n/\r)を含む場合のみダブルクォートで囲み、
// フィールド内のダブルクォートは二重化する
function csvEscapeField(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value)
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function toCsvRow(fields: unknown[]): string {
  return fields.map(csvEscapeField).join(',')
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

function isMissingRpcError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '42883' || code === 'PGRST202'
}

async function tryJsonbRpc<T>(
  client: SupabaseClient<Database>,
  functionName: string
): Promise<T | null> {
  const { data, error } = await client.rpc(functionName as never)
  if (!error) return data as T
  if (isMissingRpcError(error)) return null
  throw error
}

// maxRows省略時は既存呼び出し元と完全に同一の挙動（全件取得するまでループ）。
// maxRowsを指定すると、その件数に達した時点で打ち切る（CSVエクスポートの上限保護用）
async function fetchAllPaged(buildQuery: () => any, maxRows?: number): Promise<any[]> {
  const batchSize = 1000
  const rows: any[] = []

  for (let from = 0; maxRows === undefined || from < maxRows; from += batchSize) {
    const to = maxRows === undefined ? from + batchSize - 1 : Math.min(from + batchSize, maxRows) - 1
    const { data, error } = await buildQuery().range(from, to)
    if (error) throw error
    if (!data || data.length === 0) break

    rows.push(...data)
    if (data.length < to - from + 1) break
  }

  return rows
}

// 期間プリセットから開始日（ISO文字列）を算出する
// analysis/src/pages/StreamerGachaHistory.tsx の getFromDate と同一ロジック
function getFromDateForRange(range: TimeRange): string | null {
  if (range === 'all') return null
  const daysMap = { '7d': 7, '30d': 30, '90d': 90 }
  return new Date(Date.now() - daysMap[range] * 86400000).toISOString()
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

// streamers を渡さない場合は自前で取得する（互換性のためオプション引数として残置）。
// /streamers ルートは既に取得済みの streamers 配列を渡すことで二重取得を避ける。
async function listStreamerChatAccess(
  client: SupabaseClient<Database>,
  streamers?: ChatAccessStreamerRow[]
) {
  const resolvedStreamers =
    streamers ??
    ((await fetchAllPaged(() =>
      client
        .from('streamers')
        .select('id, twitch_user_id, chat_announcement_enabled')
        .order('created_at', { ascending: false })
    )) as ChatAccessStreamerRow[])

  const twitchIds = [...new Set(resolvedStreamers.map((streamer) => streamer.twitch_user_id))]

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
    streamers: resolvedStreamers,
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
  const announcements = (await fetchAllPaged(() =>
    client
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false })
  )) as Database['public']['Tables']['announcements']['Row'][]

  // 既読数は「read rows を全件取得してNode側で数える」のではなく、DB側の
  // COUNTだけを返すheadクエリで取得する。PostgREST/Supabase RESTは通常1回の
  // select返却行数に上限があり、announcement_readsが1000件を超えると全件取得型の
  // 集計は過小表示になる。count: 'exact' + head: true なら行データを転送せず、
  // announcement_id indexを使って正確な件数だけを返せるため、上限制約・帯域・
  // Nodeメモリ使用量のすべてを避けられる。
  const readCountsByAnnouncementId = new Map<string, number>()
  await Promise.all(
    announcements.map(async (announcement) => {
      const { count, error } = await client
        .from('announcement_reads')
        .select('*', { count: 'exact', head: true })
        .eq('announcement_id', announcement.id)
      if (error) throw error
      readCountsByAnnouncementId.set(announcement.id, count || 0)
    })
  )

  return announcements.map((announcement) => ({
    ...announcement,
    read_count: readCountsByAnnouncementId.get(announcement.id) || 0,
  }))
}

// 直近30日分、日次バケットの{date, count}配列を返す共通ヘルパー。
// growth chart(users.created_at / gacha_history.redeemed_at)の両方で使う。
// 1テーブルあたり30本のindex-onlyなCOUNTクエリをPromise.allで並列実行する
// (RPC化していない理由: getOverview()冒頭のコメント/呼び出し元コメント参照)
async function getDailyGrowth(
  client: SupabaseClient<Database>,
  table: 'users' | 'gacha_history',
  dateColumn: 'created_at' | 'redeemed_at'
): Promise<{ date: string; count: number }[]> {
  const days = 30
  const today = new Date()
  const dayStarts: Date[] = []
  for (let i = days - 1; i >= 0; i--) {
    dayStarts.push(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i))
    )
  }

  const counts = await Promise.all(
    dayStarts.map((dayStart) => {
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
      return client
        .from(table)
        .select('*', { count: 'exact', head: true })
        .gte(dateColumn, dayStart.toISOString())
        .lt(dateColumn, dayEnd.toISOString())
    })
  )

  return dayStarts.map((dayStart, index) => {
    const result = counts[index]
    if (result.error) throw result.error
    return {
      date: dayStart.toISOString().slice(0, 10),
      count: result.count || 0,
    }
  })
}

// 直近30日の gacha_history を streamer_id のみ取得し、Node側で集計してトップ10を返す。
// 表示に必要な情報(表示名/アイコン)はトップ10のstreamer_idだけ後引きする
async function getStreamerLeaderboard(client: SupabaseClient<Database>) {
  const rpcRows = await tryJsonbRpc<unknown[]>(client, 'get_analysis_streamer_leaderboard')
  if (rpcRows) return rpcRows

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const rows = (await fetchAllPaged(() =>
    client
      .from('gacha_history')
      .select('streamer_id')
      .gte('redeemed_at', thirtyDaysAgo)
  )) as { streamer_id: string }[]

  const countByStreamerId = new Map<string, number>()
  for (const row of rows) {
    countByStreamerId.set(row.streamer_id, (countByStreamerId.get(row.streamer_id) || 0) + 1)
  }

  const top10 = Array.from(countByStreamerId.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  if (top10.length === 0) return []

  const top10Ids = top10.map(([streamerId]) => streamerId)
  const { data: streamersData, error } = await client
    .from('streamers')
    .select('id, twitch_display_name, twitch_profile_image_url')
    .in('id', top10Ids)
  if (error) throw error

  const streamerById = new Map(
    (streamersData || []).map((streamer) => [streamer.id, streamer])
  )

  return top10.map(([streamerId, drawCount]) => {
    const streamer = streamerById.get(streamerId)
    return {
      streamerId,
      displayName: streamer?.twitch_display_name || 'Unknown',
      profileImageUrl: streamer?.twitch_profile_image_url ?? null,
      drawCount,
    }
  })
}

async function getOverview(client: SupabaseClient<Database>) {
  const rpcOverview = await tryJsonbRpc<unknown>(client, 'get_analysis_overview')
  if (rpcOverview) return rpcOverview

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
    userGrowth,
    gachaGrowth,
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
    getDailyGrowth(client, 'users', 'created_at'),
    getDailyGrowth(client, 'gacha_history', 'redeemed_at'),
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
    userGrowth,
    gachaGrowth,
  }
}

// analysis/src/pages/Users.tsx の fetchUsers() が期待する形と揃える
// (user.user_cards?.[0]?.count ?? 0 で件数を取り出すマッピングがそのまま動く形)
async function listUsers(client: SupabaseClient<Database>) {
  const rpcUsers = await tryJsonbRpc<unknown[]>(client, 'get_analysis_users')
  if (rpcUsers) return rpcUsers

  return fetchAllPaged(() =>
    client
      .from('users')
      .select('*, user_cards(count)')
      .order('created_at', { ascending: false })
  )
}

// analysis/src/pages/Streamers.tsx の fetchStreamers() が現在ブラウザ側で行っている
// 4つの並列クエリ + SHA-256計算(crypto.subtle, 1配信者ずつ非同期)を1本のサーバーサイド
// 処理に統合する。SHA-256はNodeの同期API(createHash)で計算するため高速。
async function listStreamersWithStats(client: SupabaseClient<Database>) {
  const rpcStreamers = await tryJsonbRpc<unknown[]>(client, 'get_analysis_streamers')
  if (rpcStreamers) return rpcStreamers

  type StreamerWithCardCount = Streamer & { cards: { count: number }[] }

  const [streamersRaw, storageUsageRows, storageBonusRows] = await Promise.all([
    fetchAllPaged(() =>
      client
        .from('streamers')
        // streamers-cards間には card_owner_stats 経由のmany-to-many関係も存在するため、
        // 素の cards(count) だと "more than one relationship was found" でPostgRESTがエラーになる。
        // 直接FK(cards_streamer_id_fkey)を明示して曖昧さを解消する
        .select('*, cards!cards_streamer_id_fkey(count)')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true }) // 安定ソート: created_at同値時のページ間重複/欠落を防ぐ
    ),
    fetchAllPaged(() =>
      client.from('storage_usage').select('user_prefix, bytes_used').neq('user_prefix', '_global_')
    ),
    fetchAllPaged(() =>
      client
        .from('streamer_storage_bonus')
        .select('streamer_id')
        .eq('type', VOTE_CAMPAIGN_TYPE)
        .eq('memo', VOTE_CAMPAIGN_MEMO)
    ),
  ])

  const streamers = streamersRaw as unknown as StreamerWithCardCount[]

  // listStreamerChatAccessに既に取得済みのstreamersを渡し、内部での再取得を避ける
  const chatAccessRows = await listStreamerChatAccess(
    client,
    streamers.map((streamer) => ({
      id: streamer.id,
      twitch_user_id: streamer.twitch_user_id,
      chat_announcement_enabled: streamer.chat_announcement_enabled,
    }))
  )
  const chatAccessByStreamerId = new Map(chatAccessRows.map((access) => [access.streamer_id, access]))

  const storageSizeByPrefix = new Map<string, number>()
  ;(storageUsageRows as { user_prefix: string; bytes_used: number }[]).forEach((row) => {
    storageSizeByPrefix.set(row.user_prefix, row.bytes_used)
  })

  const voteCampaignStreamerIdSet = new Set(
    (storageBonusRows as { streamer_id: string }[]).map((row) => row.streamer_id)
  )

  return streamers.map((streamer) => {
    const { cards, ...streamerFields } = streamer
    const cardCount = cards?.[0]?.count ?? 0

    // blob_files/storage_usageのuser_prefixと同じ方式(SHA-256先頭8文字)で算出
    const userPrefix = createHash('sha256').update(streamer.twitch_user_id).digest('hex').slice(0, 8)
    const storageBytes = storageSizeByPrefix.get(userPrefix) || 0

    const chatAccess = chatAccessByStreamerId.get(streamer.id)
    const hasVoteCampaignBonus = voteCampaignStreamerIdSet.has(streamer.id)

    return {
      ...streamerFields,
      card_count: cardCount,
      storage_bytes: storageBytes,
      has_chat_scope: chatAccess?.has_chat_scope ?? false,
      chat_send_available: chatAccess?.chat_send_available ?? false,
      has_active_bot_sender: chatAccess?.has_active_bot_sender ?? false,
      chat_sender_mode: chatAccess?.sender_mode ?? 'streamer',
      has_vote_campaign_bonus: hasVoteCampaignBonus,
    }
  })
}

// analysis/src/pages/StreamerGachaHistory.tsx のチャート用クエリと同一ロジック。
// streamerId未指定時は全ストリーマー横断(analysis/src/pages/Gacha.tsx相当)になるため
// streamers(*) も併せて埋め込む
async function getGachaChart(
  client: SupabaseClient<Database>,
  params: { range: TimeRange; streamerId?: string }
) {
  let query = client
    .from('gacha_history')
    .select('id, redeemed_at, card_id, user_twitch_id, streamer_id, cards(id, name, rarity, image_url), streamers(*)')
    .order('redeemed_at', { ascending: false })
    .limit(10000)

  if (params.streamerId) {
    query = query.eq('streamer_id', params.streamerId)
  }

  const fromDate = getFromDateForRange(params.range)
  if (fromDate) {
    query = query.gte('redeemed_at', fromDate)
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

async function getGachaSummary(
  client: SupabaseClient<Database>,
  params: { range: TimeRange; streamerId?: string }
) {
  const fromDate = getFromDateForRange(params.range)
  const { data, error } = await client.rpc('get_analysis_gacha_summary' as never, {
    p_from_date: fromDate,
    p_streamer_id: params.streamerId ?? null,
  } as never)
  if (!error) return data
  if (!isMissingRpcError(error)) throw error

  // RPC未適用の開発環境だけ従来の10,000件bounded集計に戻す。
  // 通常経路はDB側GROUP BY済みの小さいJSONを返し、gacha画面初期表示で
  // 履歴行を大量転送しないことを性能改善の主目的としている。
  const chartRows = await getGachaChart(client, params)
  const dailyCounts = new Map<string, number>()
  const rarityCounts = new Map<string, number>()
  const cardCounts = new Map<string, { card: GachaChartCard; count: number }>()
  let legendaryCount = 0

  for (const row of chartRows as GachaChartRow[]) {
    const date = row.redeemed_at.slice(0, 10)
    dailyCounts.set(date, (dailyCounts.get(date) || 0) + 1)

    if (row.cards?.rarity) {
      rarityCounts.set(row.cards.rarity, (rarityCounts.get(row.cards.rarity) || 0) + 1)
      if (row.cards.rarity === 'legendary') legendaryCount++
    }

    if (row.cards) {
      const existing = cardCounts.get(row.cards.id)
      if (existing) existing.count++
      else cardCounts.set(row.cards.id, { card: row.cards, count: 1 })
    }
  }

  return {
    totalGacha: chartRows.length,
    uniqueUsers: new Set((chartRows as GachaChartRow[]).map((row) => row.user_twitch_id)).size,
    legendaryCount,
    dailyGachaData: Array.from(dailyCounts.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    rarityDistribution: Array.from(rarityCounts.entries()).map(([rarity, count]) => ({
      name: rarity.charAt(0).toUpperCase() + rarity.slice(1),
      value: count,
      rarity,
    })),
    popularCards: Array.from(cardCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  }
}

// analysis/src/pages/StreamerGachaHistory.tsx のテーブル用クエリと同一ロジック。
// streamerIdが指定されている場合のみ絞り込む点だけが per-streamer 版との違い
async function getGachaTable(
  client: SupabaseClient<Database>,
  params: {
    range: TimeRange
    page: number
    pageSize: number
    username: string
    rarity: string
    from: string
    to: string
    streamerId?: string
  }
) {
  const { range, page, pageSize, username, rarity, from, to, streamerId } = params

  // レアリティフィルタ時は !inner JOIN で正確なcountを保証
  const joinType = rarity ? 'cards!inner(*)' : 'cards(*)'
  let query = client
    .from('gacha_history')
    .select(`*, ${joinType}, streamers(*)`, { count: 'exact' })

  if (streamerId) {
    query = query.eq('streamer_id', streamerId)
  }

  // 期間フィルタ: 日付フィルタ（from/to）が設定されていなければ range を適用
  if (!from && !to) {
    const fromDate = getFromDateForRange(range)
    if (fromDate) {
      query = query.gte('redeemed_at', fromDate)
    }
  }

  // ユーザー名フィルタ（ILIKE部分一致、パターン文字エスケープ）
  if (username) {
    const escaped = username.replace(/%/g, '\\%').replace(/_/g, '\\_')
    query = query.ilike('user_twitch_username', `%${escaped}%`)
  }

  if (rarity) {
    query = query.eq('cards.rarity', rarity)
  }

  if (from) {
    query = query.gte('redeemed_at', `${from}T00:00:00Z`)
  }

  if (to) {
    const nextDay = new Date(`${to}T00:00:00Z`)
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)
    query = query.lt('redeemed_at', nextDay.toISOString())
  }

  const offset = (page - 1) * pageSize
  query = query.order('redeemed_at', { ascending: false }).range(offset, offset + pageSize - 1)

  const { data, count, error } = await query
  if (error) throw error
  return { rows: data || [], count: count || 0 }
}

// GET /__admin/gacha/export 用の行取得。getGachaTable()と同じフィルタロジックだが
// ページネーションなし・全件取得（安全のため50,000件上限）。取得する列も
// CSV出力に必要な最小限（redeemed_at / username / card名・レアリティ / streamer名）に絞る
const GACHA_EXPORT_ROW_LIMIT = 50000

type GachaExportRow = {
  redeemed_at: string
  user_twitch_username: string | null
  cards: { name: string; rarity: string } | { name: string; rarity: string }[] | null
  streamers: { twitch_display_name: string } | { twitch_display_name: string }[] | null
}

async function getGachaExportRows(
  client: SupabaseClient<Database>,
  params: {
    range: TimeRange
    username: string
    rarity: string
    from: string
    to: string
    streamerId?: string
  }
): Promise<GachaExportRow[]> {
  const { range, username, rarity, from, to, streamerId } = params

  // レアリティフィルタ時は !inner JOIN で絞り込みが効くようにする（getGachaTableと同様）
  const joinType = rarity ? 'cards!inner(name, rarity)' : 'cards(name, rarity)'

  // PostgREST側のmax-rows設定により単発クエリの.limit()は実際には効かず1000件で
  // 打ち切られてしまう（他のfetchAllPaged利用箇所と同じ制約）。そのため単発.limit(50000)
  // ではなく、range()を1000件ずつ回すfetchAllPagedスタイルでmaxRows件まで積み上げる
  const buildQuery = () => {
    let query = client
      .from('gacha_history')
      .select(`redeemed_at, user_twitch_username, ${joinType}, streamers(twitch_display_name)`)

    if (streamerId) {
      query = query.eq('streamer_id', streamerId)
    }

    // 期間フィルタ: 日付フィルタ（from/to）が設定されていなければ range を適用
    if (!from && !to) {
      const fromDate = getFromDateForRange(range)
      if (fromDate) {
        query = query.gte('redeemed_at', fromDate)
      }
    }

    // ユーザー名フィルタ（ILIKE部分一致、パターン文字エスケープ）
    if (username) {
      const escaped = username.replace(/%/g, '\\%').replace(/_/g, '\\_')
      query = query.ilike('user_twitch_username', `%${escaped}%`)
    }

    if (rarity) {
      query = query.eq('cards.rarity', rarity)
    }

    if (from) {
      query = query.gte('redeemed_at', `${from}T00:00:00Z`)
    }

    if (to) {
      const nextDay = new Date(`${to}T00:00:00Z`)
      nextDay.setUTCDate(nextDay.getUTCDate() + 1)
      query = query.lt('redeemed_at', nextDay.toISOString())
    }

    return query.order('redeemed_at', { ascending: false })
  }

  const rows = await fetchAllPaged(buildQuery, GACHA_EXPORT_ROW_LIMIT)
  return rows as unknown as GachaExportRow[]
}

// PostgRESTのネスト埋め込みは通常オブジェクトを返すが、型上は配列の可能性もあるため
// どちらの形でも安全に最初の要素相当を取り出す
function firstOf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

function buildGachaExportCsv(rows: GachaExportRow[]): string {
  const header = toCsvRow(['redeemed_at', 'streamer', 'username', 'card_name', 'rarity'])
  const lines = rows.map((row) => {
    const card = firstOf(row.cards)
    const streamer = firstOf(row.streamers)
    return toCsvRow([
      new Date(row.redeemed_at).toLocaleString('ja-JP'),
      streamer?.twitch_display_name ?? '',
      row.user_twitch_username ?? '',
      card?.name ?? '',
      card?.rarity ?? '',
    ])
  })
  return [header, ...lines].join('\r\n') + '\r\n'
}

// GET /__admin/gacha/export のハンドラ。他ルートと違いJSONではなくtext/csvを返すため、
// configureServer側でhandleRoute()+sendJson()の汎用ディスパッチより前段で特別扱いする
async function handleGachaExport(
  client: SupabaseClient<Database>,
  url: URL,
  res: ServerResponse
): Promise<void> {
  try {
    const range = (url.searchParams.get('range') || 'all') as TimeRange
    const username = url.searchParams.get('username') || ''
    const rarity = url.searchParams.get('rarity') || ''
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''
    const streamerId = url.searchParams.get('streamerId') || undefined

    const rows = await getGachaExportRows(client, { range, username, rarity, from, to, streamerId })
    const csv = buildGachaExportCsv(rows)

    res.statusCode = 200
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader('content-disposition', 'attachment; filename="gacha-export.csv"')
    res.end(csv)
  } catch (error) {
    console.error('[local-admin-api]', error)
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500
    const message = error instanceof Error ? error.message : 'Export failed'
    res.statusCode = status
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.end(toCsvRow(['error']) + '\r\n' + toCsvRow([message]) + '\r\n')
  }
}

// analysis/src/components/DropRateStats.tsx が呼んでいるロジックのRPC版薄いラッパー。
// get_gacha_drop_stats の戻り値(JSONB)をそのまま返す — サーバー側での再整形はしない
async function getDropRateStats(
  client: SupabaseClient<Database>,
  params: { streamerId: string; range: TimeRange }
) {
  const fromDate = getFromDateForRange(params.range)
  const { data, error } = await client.rpc('get_gacha_drop_stats' as never, {
    p_streamer_id: params.streamerId,
    p_from_date: fromDate ?? '1970-01-01T00:00:00Z',
    p_limit_per_card: 20,
  } as never)
  if (error) throw error
  return data
}

// analysis/src/pages/UserCards.tsx の :userId (内部users.id) からユーザーとカード所持サマリーを返す
async function getUserCardsSummary(client: SupabaseClient<Database>, userId: string) {
  const { data: user, error } = await client.from('users').select('*').eq('id', userId).single()
  if (error) {
    // PGRST116: .single()で0件/複数件だった場合のPostgRESTエラーコード
    if ((error as { code?: string }).code === 'PGRST116') {
      throw Object.assign(new Error('User not found'), { statusCode: 404 })
    }
    throw error
  }

  const { data: cardCounts, error: rpcError } = await client.rpc('get_user_card_counts' as never, {
    p_twitch_user_id: user.twitch_user_id,
  } as never)
  if (rpcError) throw rpcError

  return { user, cardCounts }
}

// analysis/src/pages/UserCards.tsx が現在.range(0, 9999)で単発取得しているuser_cardsの
// サーバーサイドページネーション版。streamerは各カードのstreamer_idからまとめて引き当てて埋め込む
async function getUserCardsTable(
  client: SupabaseClient<Database>,
  params: { userId: string; page: number; pageSize: number }
) {
  const { userId, page, pageSize } = params
  const offset = (page - 1) * pageSize

  const { data, count, error } = await client
    .from('user_cards')
    .select(
      'id, card_id, obtained_at, cards(id, streamer_id, name, description, image_url, rarity, drop_rate, is_active, created_at, updated_at)',
      { count: 'exact' }
    )
    .eq('user_id', userId)
    .order('obtained_at', { ascending: false })
    .range(offset, offset + pageSize - 1)
  if (error) throw error

  type UserCardRow = {
    id: string
    card_id: string
    obtained_at: string
    cards: Card | null
  }
  const rows = (data || []) as unknown as UserCardRow[]

  const streamerIds = [
    ...new Set(rows.map((row) => row.cards?.streamer_id).filter((id): id is string => Boolean(id))),
  ]

  let streamersById = new Map<string, Streamer>()
  if (streamerIds.length > 0) {
    const { data: streamersData, error: streamersError } = await client
      .from('streamers')
      .select('*')
      .in('id', streamerIds)
    if (streamersError) throw streamersError
    streamersById = new Map((streamersData || []).map((s) => [s.id, s]))
  }

  const rowsWithStreamer = rows.map((row) => ({
    ...row,
    streamer: row.cards ? streamersById.get(row.cards.streamer_id) || null : null,
  }))

  return { rows: rowsWithStreamer, count: count || 0 }
}

// analysis/src/pages/StreamerCards.tsx が現在.range(0, 9999)で単発取得しているcardsの
// サーバーサイドページネーション版。並び順(レアリティ降順→作成日降順)は既存と同一
async function getStreamerCardsPage(
  client: SupabaseClient<Database>,
  params: { streamerId: string; page: number; pageSize: number }
) {
  const { streamerId, page, pageSize } = params
  const offset = (page - 1) * pageSize

  const { data, count, error } = await client
    .from('cards')
    .select('*', { count: 'exact' })
    .eq('streamer_id', streamerId)
    .order('rarity', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1)
  if (error) throw error
  return { rows: data || [], count: count || 0 }
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

  // getStreamerLeaderboard()は直近30日のgacha_history全件(~65,000行超)をfetchAllPagedで
  // ページングして集計するため20秒前後かかる。getOverview()と分離し、Overviewページ側で
  // 独立ロードできるようにする(他の統計をブロックしないため)
  if (req.method === 'GET' && path === '/overview/leaderboard') {
    return getStreamerLeaderboard(client)
  }

  if (req.method === 'GET' && path === '/users') {
    return listUsers(client)
  }

  if (req.method === 'GET' && path === '/streamers') {
    return listStreamersWithStats(client)
  }

  if (req.method === 'GET' && path === '/gacha/chart') {
    const range = (url.searchParams.get('range') || 'all') as TimeRange
    const streamerId = url.searchParams.get('streamerId') || undefined
    return getGachaChart(client, { range, streamerId })
  }

  if (req.method === 'GET' && path === '/gacha/summary') {
    const range = (url.searchParams.get('range') || 'all') as TimeRange
    const streamerId = url.searchParams.get('streamerId') || undefined
    return getGachaSummary(client, { range, streamerId })
  }

  if (req.method === 'GET' && path === '/gacha/table') {
    const range = (url.searchParams.get('range') || 'all') as TimeRange
    const page = Number(url.searchParams.get('page') || '1')
    const pageSize = Number(url.searchParams.get('pageSize') || '20')
    const username = url.searchParams.get('username') || ''
    const rarity = url.searchParams.get('rarity') || ''
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''
    const streamerId = url.searchParams.get('streamerId') || undefined
    return getGachaTable(client, { range, page, pageSize, username, rarity, from, to, streamerId })
  }

  if (req.method === 'GET' && path === '/drop-rate-stats') {
    const streamerId = url.searchParams.get('streamerId')
    if (!streamerId) {
      throw Object.assign(new Error('streamerId is required'), { statusCode: 400 })
    }
    const range = (url.searchParams.get('range') || 'all') as TimeRange
    return getDropRateStats(client, { streamerId, range })
  }

  if (req.method === 'GET' && path === '/user-cards/summary') {
    const userId = url.searchParams.get('userId')
    if (!userId) {
      throw Object.assign(new Error('userId is required'), { statusCode: 400 })
    }
    return getUserCardsSummary(client, userId)
  }

  if (req.method === 'GET' && path === '/user-cards/table') {
    const userId = url.searchParams.get('userId')
    if (!userId) {
      throw Object.assign(new Error('userId is required'), { statusCode: 400 })
    }
    const page = Number(url.searchParams.get('page') || '1')
    const pageSize = Number(url.searchParams.get('pageSize') || '20')
    return getUserCardsTable(client, { userId, page, pageSize })
  }

  if (req.method === 'GET' && path === '/streamer-cards') {
    const streamerId = url.searchParams.get('streamerId')
    if (!streamerId) {
      throw Object.assign(new Error('streamerId is required'), { statusCode: 400 })
    }
    const page = Number(url.searchParams.get('page') || '1')
    const pageSize = Number(url.searchParams.get('pageSize') || '20')
    return getStreamerCardsPage(client, { streamerId, page, pageSize })
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

        const url = new URL(req.url || '/', 'http://localhost')

        try {
          client ||= getSupabaseClient(env)

          // CSVを返すエクスポート用ルートはJSON専用のhandleRoute()+sendJson()の
          // 汎用ディスパッチに乗せられないため、ここで先取りして個別処理する。
          // connectのミドルウェアマウント('/__admin')によりreq.url/url.pathnameからは
          // 既に/__adminプレフィックスが取り除かれている点に注意（handleRoute内のpath
          // 変換と同様）
          if (req.method === 'GET' && url.pathname === '/gacha/export') {
            await handleGachaExport(client, url, res)
            return
          }

          const body = await readBody(req)
          const result = await handleRoute({ req, res, client, body, url })
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
