import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Card, SupabaseAdminSchema, InquiryStatus, Rarity, Streamer } from '../src/types/database'
import {
  createAnnouncementPg,
  createSupportCodePg,
  createSupportInquiryMessagePg,
  deleteAnnouncementPg,
  getAnalysisDbDriver,
  getDropRateStatsPg,
  getGachaChartPg,
  getGachaExportRowsPg,
  getGachaSummaryPg,
  getGachaTablePg,
  getOverviewPg,
  getStreamerByIdPg,
  getStreamerCardsPagePg,
  getStreamerLeaderboardPg,
  getSupportInquiriesPg,
  getUserCardsSummaryPg,
  getUserCardsTablePg,
  listAnnouncementsPg,
  listLicensesPg,
  listStreamersWithStatsPg,
  listSupportCodesPg,
  listSupportInquiryMessagesPg,
  listTwitchSubsPg,
  listUsersPg,
  revokeSupportCodePg,
  updateAnnouncementPg,
  updateSupportCodeStatusPg,
  updateSupportInquiryStatusPg,
} from './adminApiPg'

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

type RouteContext = {
  req: IncomingMessage
  res: ServerResponse
  client: SupabaseClient<SupabaseAdminSchema>
  url: URL
  body: unknown
  env: Env
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

// CSVの数式インジェクション対策（OWASP CSV Injection）:
// Excel/Google Sheets等は先頭が =, +, -, @ (またはTab/CR)のセルを数式として評価する。
// streamer表示名・ユーザー名・カード名はユーザー起因の値になりうるため、
// 該当パターンならシングルクォートを前置して文字列として解釈させる
function sanitizeCsvFormula(str: string): string {
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`
  }
  return str
}

// CSVフィールドの最小限の正しいエスケープ（RFC4180）:
// カンマ・ダブルクォート・改行(\n/\r)を含む場合のみダブルクォートで囲み、
// フィールド内のダブルクォートは二重化する
function csvEscapeField(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value)
  const sanitized = sanitizeCsvFormula(str)
  if (/[",\n\r]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
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

function getSupabaseClient(env: Env): SupabaseClient<SupabaseAdminSchema> {
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

  return createClient<SupabaseAdminSchema>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}

/**
 * pg専用構成（ANALYSIS_DB_DRIVER=pg）でSupabaseクライアントの代わりに使うsentinel。
 * 触れた瞬間に自己説明的なエラーを投げるため、将来pg分岐より前にclientを参照する
 * バグが混入しても、原因不明のnull参照エラーではなくその場で気づける。
 */
function createSupabaseClientAccessSentinel(): SupabaseClient<SupabaseAdminSchema> {
  return new Proxy({} as SupabaseClient<SupabaseAdminSchema>, {
    get() {
      throw new Error(
        'Supabase client accessed under ANALYSIS_DB_DRIVER=pg — pg経路のバグです。' +
          'ルートラッパー関数は getAnalysisDbDriver(env) === "pg" を判定してから client に触れること。'
      )
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

// get_analysis_*() JSONB RPC（00073_add_analysis_dashboard_rpcs.sql）を呼ぶ共通ヘルパー。
//
// #700 以前は関数未検出（42883/PGRST202）時に無音でNode側の低速な全件集計へ
// フォールバックしていたが、この設計はPlanetScale移行後にRPC未適用というスキーマ
// 不備を隠してしまう（issue #700本文・2026-07-10コメント）。そのためフォールバックは
// 廃止し、missing RPCも通常のエラーと同様に明示的に呼び出し元へ伝播させる。
// pg直結経路（adminApiPg.ts の callAnalysisJsonFunction）も同じ方針で実装済みであり、
// 両経路の挙動を揃える。
// ただし getGachaSummary はこの callJsonbRpc を経由しておらず、パラメータ付き
// RPC呼び出しのため従来のsilent fallbackが未対応のまま残っている
// （フォローアップ: issue #700のコメント参照。callJsonbRpc にパラメータ引数を
// 追加して統合する形で別途対応が必要）。
//
// missing RPCの場合だけ、原因（未適用のmigration）を名指しした分かりやすい
// メッセージへ差し替える。呼び出し元の外側ハンドラ（localAdminApiPlugin内のcatch）が
// error.messageをそのままJSONレスポンスに含めるため、生のPostgrestError（
// 「Could not find the function ...」等）よりも運用者が対処しやすい文言にする。
async function callJsonbRpc<T>(
  client: SupabaseClient<SupabaseAdminSchema>,
  functionName: string
): Promise<T> {
  const { data, error } = await client.rpc(functionName as never)
  if (!error) return data as T
  if (isMissingRpcError(error)) {
    throw Object.assign(
      new Error(
        `Required RPC "${functionName}" is missing. Apply ` +
          'supabase/migrations/00073_add_analysis_dashboard_rpcs.sql (or later) to this database.'
      ),
      { cause: error }
    )
  }
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

const VALID_TIME_RANGES: readonly TimeRange[] = ['7d', '30d', '90d', 'all']

// 不正な range 文字列を受け取ると daysMap[range] が undefined になり、
// getFromDateForRange() 内で NaN 経由の Invalid Date → toISOString() 例外という
// 分かりにくい500になる。ここで早期にバリデーションして400を返す
function parseTimeRange(raw: string | null): TimeRange {
  if (raw === null) return 'all'
  if ((VALID_TIME_RANGES as readonly string[]).includes(raw)) return raw as TimeRange
  throw Object.assign(new Error(`Invalid range: ${raw}`), { statusCode: 400 })
}

// page/pageSizeが未検証だと page=0 や負値で range() に負のoffsetが渡り、
// PostgRESTエラー経由の素の500として露出してしまう。ここで検証して400を返す
function parsePagination(url: URL): { page: number; pageSize: number } {
  const page = Number(url.searchParams.get('page') || '1')
  const pageSize = Number(url.searchParams.get('pageSize') || '20')
  if (!Number.isInteger(page) || page < 1) {
    throw Object.assign(new Error('page must be a positive integer'), { statusCode: 400 })
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw Object.assign(new Error('pageSize must be a positive integer up to 1000'), {
      statusCode: 400,
    })
  }
  return { page, pageSize }
}

export async function listLicenses(client: SupabaseClient<SupabaseAdminSchema>, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return listLicensesPg(env)
  }

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

export async function listSupportCodes(client: SupabaseClient<SupabaseAdminSchema>, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return listSupportCodesPg(env)
  }
  const { data, error } = await client
    .from('support_codes')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function createSupportCode(
  client: SupabaseClient<SupabaseAdminSchema>,
  payload: Record<string, unknown>,
  env: Env
) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return createSupportCodePg(env, {
      codeHash: String(payload.code_hash || ''),
      planType: payload.plan_type,
      memo: payload.memo || null,
    })
  }
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

export async function updateSupportCodeStatus(
  client: SupabaseClient<SupabaseAdminSchema>,
  id: string,
  status: unknown,
  env: Env
) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return updateSupportCodeStatusPg(env, { id, status })
  }
  const { data, error } = await client
    .from('support_codes')
    .update({ status, updated_at: new Date().toISOString() } as never)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function revokeSupportCode(client: SupabaseClient<SupabaseAdminSchema>, codeId: string, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return revokeSupportCodePg(env, codeId)
  }
  const { error } = await client.rpc('revoke_support_code' as never, {
    p_code_id: codeId,
  } as never)
  if (error) throw error
  return { ok: true }
}

export async function listTwitchSubs(client: SupabaseClient<SupabaseAdminSchema>, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return listTwitchSubsPg(env)
  }
  const { data, count, error } = await client
    .from('users')
    .select('twitch_user_id, twitch_display_name, twitch_sub_verified_at', { count: 'exact' })
    .eq('twitch_has_sub', true)
    .order('twitch_sub_verified_at', { ascending: false })
  if (error) throw error
  return { rows: data || [], count: count || 0 }
}

export async function getSupportInquiries(
  client: SupabaseClient<SupabaseAdminSchema>,
  status: string,
  env: Env
) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return getSupportInquiriesPg(env, status)
  }
  let query = client
    .from('support_inquiries')
    .select('*')
    .order('created_at', { ascending: false })

  if (status !== 'all') {
    // statusはクエリパラメータ由来の任意文字列（バリデーションなしは既存挙動を維持）。
    // 不正な値の場合はPostgREST側で単に0件ヒットになるだけで実害はないため、
    // 実行時の挙動を変えない型アサーションで対応する
    query = query.eq('status', status as InquiryStatus)
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export async function updateSupportInquiryStatus(
  client: SupabaseClient<SupabaseAdminSchema>,
  id: string,
  status: unknown,
  env: Env
) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return updateSupportInquiryStatusPg(env, { id, status })
  }
  const { data, error } = await client
    .from('support_inquiries')
    .update({ status, updated_at: new Date().toISOString() } as never)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function listSupportInquiryMessages(
  client: SupabaseClient<SupabaseAdminSchema>,
  inquiryId: string,
  env: Env
) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return listSupportInquiryMessagesPg(env, inquiryId)
  }
  const { data, error } = await client
    .from('support_inquiry_messages')
    .select('*')
    .eq('inquiry_id', inquiryId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

export async function createSupportInquiryMessage(
  client: SupabaseClient<SupabaseAdminSchema>,
  inquiryId: string,
  messageBody: string,
  env: Env
) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return createSupportInquiryMessagePg(env, { inquiryId, body: messageBody })
  }
  const { data, error } = await client
    .from('support_inquiry_messages')
    .insert({
      inquiry_id: inquiryId,
      sender_type: 'admin',
      sender_id: 'admin',
      body: messageBody,
    } as never)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function listAnnouncements(client: SupabaseClient<SupabaseAdminSchema>, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return listAnnouncementsPg(env)
  }
  // announcementごとに個別のcountクエリを発行するとN件でN+1ラウンドトリップになる。
  // announcement_reads.announcement_id → announcements.id は単一FK(曖昧さなし)なので、
  // 他のRPCフォールバック箇所(user_cards(count)など)と同じくPostgRESTのネスト埋め込み
  // count集約で1クエリにまとめる
  const rows = (await fetchAllPaged(() =>
    client
      .from('announcements')
      .select('*, announcement_reads(count)')
      .order('created_at', { ascending: false })
  )) as (SupabaseAdminSchema['public']['Tables']['announcements']['Row'] & {
    announcement_reads: { count: number }[]
  })[]

  return rows.map((row) => {
    const { announcement_reads, ...announcement } = row
    return {
      ...announcement,
      read_count: announcement_reads?.[0]?.count ?? 0,
    }
  })
}

// 直近30日の配信者別ガチャ数トップ10を返す。集計は get_analysis_streamer_leaderboard()
// （00073_add_analysis_dashboard_rpcs.sql）がDB側で行う。
// missing RPC時にNode側で直近30日のgacha_history全件を取得し手動集計する低速な
// フォールバックが以前ここにあったが、#700によりRPC欠落を無音で隠す設計を廃止したため削除した
// （callJsonbRpc がmissing RPCを含め常に例外を伝播する）。
export async function getStreamerLeaderboard(client: SupabaseClient<SupabaseAdminSchema>, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') return getStreamerLeaderboardPg(env)
  return callJsonbRpc<unknown[]>(client, 'get_analysis_streamer_leaderboard')
}

// overview統計（ユーザー数・配信者数・カード数・期間別ガチャ数・直近ガチャ・日次成長）を
// 返す。集計は get_analysis_overview()（00073_add_analysis_dashboard_rpcs.sql）が
// DB側で行う。missing RPC時にPromise.allで複数countクエリ+30日分の日次成長クエリ
// (getDailyGrowth、1テーブルあたり30本のCOUNTクエリ)をNode側で発行するフォールバックが
// 以前ここにあったが、#700によりRPC欠落を無音で隠す設計を廃止したため削除した
// （callJsonbRpc がmissing RPCを含め常に例外を伝播する）。
export async function getOverview(client: SupabaseClient<SupabaseAdminSchema>, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') return getOverviewPg(env)
  return callJsonbRpc<unknown>(client, 'get_analysis_overview')
}

// analysis/src/pages/Users.tsx の fetchUsers() が期待する形と揃える
// (user.user_cards?.[0]?.count ?? 0 で件数を取り出すマッピングがそのまま動く形)
//
// select('*') は使わない: users テーブルには twitch_access_token / twitch_refresh_token
// などのOAuth秘匿情報が実カラムとして存在する（analysis の SupabaseAdminSchema 型には未反映）ため、
// admin API のJSONレスポンスに含めないよう、フロントが使う列だけを明示的に指定する
// exportはテストのため（adminApiPg.ts の getUserCardsSummaryPg が同じ列集合を
// 独立に jsonb_build_object() として持つため、テストで両者の列集合一致を検証する）
export const USER_SAFE_COLUMNS =
  'id, twitch_user_id, twitch_username, twitch_display_name, twitch_profile_image_url, tos_accepted_at, twitch_scopes, created_at, updated_at'

// ユーザー一覧（カード所持数付き）を返す。集計は get_analysis_users()
// （00073_add_analysis_dashboard_rpcs.sql）がDB側で行う。missing RPC時にfetchAllPaged
// でusers全件+user_cards(count)埋め込みを取得するフォールバックが以前ここにあったが、
// #700によりRPC欠落を無音で隠す設計を廃止したため削除した
// （callJsonbRpc がmissing RPCを含め常に例外を伝播する）。
export async function listUsers(client: SupabaseClient<SupabaseAdminSchema>, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') return listUsersPg(env)
  return callJsonbRpc<unknown[]>(client, 'get_analysis_users')
}

// analysis/src/pages/Streamers.tsx の fetchStreamers() が期待する、カード数・
// ストレージ使用量・チャット送信可否・投票キャンペーン特典を含む配信者一覧を返す。
// 集計は get_analysis_streamers()（00073_add_analysis_dashboard_rpcs.sql）がDB側で行う。
// missing RPC時にstreamers/storage_usage/streamer_storage_bonusを個別取得しSHA-256計算・
// チャットアクセス判定（listStreamerChatAccess）をNode側で組み立てるフォールバックが
// 以前ここにあったが、#700によりRPC欠落を無音で隠す設計を廃止したため削除した
// （callJsonbRpc がmissing RPCを含め常に例外を伝播する）。
export async function listStreamersWithStats(client: SupabaseClient<SupabaseAdminSchema>, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') return listStreamersWithStatsPg(env)
  return callJsonbRpc<unknown[]>(client, 'get_analysis_streamers')
}

// #701: StreamerCards.tsx/StreamerGachaHistory.tsxがブラウザから直接
// supabase.from('streamers').select('*').eq('id', id).single() していた箇所を
// /__admin API経由に置き換えるための単一ストリーマー取得エンドポイント。
//
// 意図的な挙動変化: 旧ブラウザ経路はanon/publishable key + RLSポリシー
// 「Active streamers are viewable by everyone」(USING (is_active = true)、
// 00001_initial_schema.sql)の制約下にあり、is_active=falseのstreamerは
// 0件（エラー表示）だった。この新経路はservice-role/pg直結のためinactiveな
// streamerも返す。管理ダッシュボードの`/streamers`一覧は元々is_activeを問わず
// 全件表示しているため、この単体取得もそれに揃える形の意図的な改善である
// （既存の一覧表示との一貫性が取れていなかった旧挙動の方が不整合だった）。
export async function getStreamerById(client: SupabaseClient<SupabaseAdminSchema>, id: string, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return getStreamerByIdPg(env, id)
  }
  const { data, error } = await client.from('streamers').select('*').eq('id', id).single()
  if (error) {
    // PGRST116: .single()で0件/複数件だった場合のPostgRESTエラーコード
    // (getUserCardsSummaryの404マッピングと同じパターン)
    if ((error as { code?: string }).code === 'PGRST116') {
      throw Object.assign(new Error('Streamer not found'), { statusCode: 404 })
    }
    throw error
  }
  return data
}

// analysis/src/pages/StreamerGachaHistory.tsx のチャート用クエリと同一ロジック。
// streamerId未指定時は全ストリーマー横断(analysis/src/pages/Gacha.tsx相当)になるため
// streamers(*) も併せて埋め込む
export async function getGachaChart(
  client: SupabaseClient<SupabaseAdminSchema>,
  params: { range: TimeRange; streamerId?: string },
  env: Env
) {
  const fromDate = getFromDateForRange(params.range)

  if (getAnalysisDbDriver(env) === 'pg') {
    return getGachaChartPg(env, { streamerId: params.streamerId, fromDate })
  }

  let query = client
    .from('gacha_history')
    .select('id, redeemed_at, card_id, user_twitch_id, streamer_id, cards(id, name, rarity, image_url), streamers(*)')
    .order('redeemed_at', { ascending: false })
    .limit(10000)

  if (params.streamerId) {
    query = query.eq('streamer_id', params.streamerId)
  }

  if (fromDate) {
    query = query.gte('redeemed_at', fromDate)
  }

  const { data, error } = await query
  if (error) throw error
  return data || []
}

export async function getGachaSummary(
  client: SupabaseClient<SupabaseAdminSchema>,
  params: { range: TimeRange; streamerId?: string },
  env: Env
) {
  const fromDate = getFromDateForRange(params.range)

  if (getAnalysisDbDriver(env) === 'pg') {
    return getGachaSummaryPg(env, { fromDate, streamerId: params.streamerId ?? null })
  }

  const { data, error } = await client.rpc('get_analysis_gacha_summary' as never, {
    p_from_date: fromDate,
    p_streamer_id: params.streamerId ?? null,
  } as never)
  if (!error) return data
  if (!isMissingRpcError(error)) throw error

  // RPC未適用の開発環境だけ従来の10,000件bounded集計に戻す。
  // 通常経路はDB側GROUP BY済みの小さいJSONを返し、gacha画面初期表示で
  // 履歴行を大量転送しないことを性能改善の主目的としている。
  const chartRows = await getGachaChart(client, params, env)
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
    totalGacha: (chartRows as GachaChartRow[]).length,
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

// ILIKE 部分一致用のパターン文字エスケープ（%/_）。
// getGachaTable/getGachaExportRows のSupabase経路・pg経路の両方で共有する
// (exportはテストのため。呼び出し元はこのファイル内の2関数のみを想定)
export function escapeIlikePattern(value: string): string {
  return value.replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// to（YYYY-MM-DD）を「翌日0時（exclusive上限）」のISO文字列に変換する。
// getGachaTable/getGachaExportRows のSupabase経路・pg経路の両方で共有する
// (exportはテストのため。呼び出し元はこのファイル内の2関数のみを想定)
export function computeExclusiveToDateIso(to: string): string {
  const nextDay = new Date(`${to}T00:00:00Z`)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  return nextDay.toISOString()
}

// getGachaTable/getGachaExportRowsの日付フィルタ計算をpg経路向けに切り出したもの。
// 「from/toが両方未指定ならrangeを使う。片方でも指定されていればrangeは無視し、
// from/toをそれぞれ独立に適用する」という、両関数のSupabase経路と同一のロジック
// (exportはテストのため。呼び出し元はこのファイル内の2関数のみを想定)
export function resolveGachaDateFilters(params: {
  range: TimeRange
  from: string
  to: string
}): { fromDate?: string; toDateExclusive?: string } {
  const { range, from, to } = params
  const fromDate =
    !from && !to
      ? (getFromDateForRange(range) ?? undefined)
      : from
        ? `${from}T00:00:00Z`
        : undefined
  const toDateExclusive = to ? computeExclusiveToDateIso(to) : undefined
  return { fromDate, toDateExclusive }
}

// analysis/src/pages/StreamerGachaHistory.tsx のテーブル用クエリと同一ロジック。
// streamerIdが指定されている場合のみ絞り込む点だけが per-streamer 版との違い
export async function getGachaTable(
  client: SupabaseClient<SupabaseAdminSchema>,
  params: {
    range: TimeRange
    page: number
    pageSize: number
    username: string
    rarity: string
    from: string
    to: string
    streamerId?: string
  },
  env: Env
) {
  const { range, page, pageSize, username, rarity, from, to, streamerId } = params

  if (getAnalysisDbDriver(env) === 'pg') {
    const { fromDate, toDateExclusive } = resolveGachaDateFilters({ range, from, to })
    return getGachaTablePg(
      env,
      {
        streamerId,
        fromDate,
        toDateExclusive,
        usernameIlike: username ? `%${escapeIlikePattern(username)}%` : undefined,
        rarity: rarity || undefined,
      },
      { offset: (page - 1) * pageSize, pageSize }
    )
  }

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
    query = query.ilike('user_twitch_username', `%${escapeIlikePattern(username)}%`)
  }

  if (rarity) {
    // rarityはクエリパラメータ由来の任意文字列（バリデーションなしは既存挙動を維持）。
    // Rarity型に合致しない値の場合はPostgREST側で単に0件ヒットになるだけで実害はないため、
    // 実行時の挙動を変えない型アサーションで対応する
    query = query.eq('cards.rarity', rarity as Rarity)
  }

  if (from) {
    query = query.gte('redeemed_at', `${from}T00:00:00Z`)
  }

  if (to) {
    query = query.lt('redeemed_at', computeExclusiveToDateIso(to))
  }

  const offset = (page - 1) * pageSize
  // redeemed_at のみだと同一タイムスタンプの行が多い場合にページ跨ぎで重複/欠落しうるため、
  // id を安定ソートのタイブレーカーとして追加する(listStreamersWithStatsと同じ対策)
  query = query
    .order('redeemed_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await query
  if (error) throw error
  return { rows: data || [], count: count || 0 }
}

// GET /__admin/gacha/export 用の行取得。getGachaTable()と同じフィルタロジックだが
// ページネーションなし・全件取得（安全のため50,000件上限）。取得する列も
// CSV出力に必要な最小限（redeemed_at / username / card名・レアリティ / streamer名）に絞る
//
// pg経路側にも同値の上限 GACHA_EXPORT_ROW_LIMIT_PG（adminApiPg.ts）が独立定義されている。
// import循環を避けるため定数を共有していない。上限値を変更する場合は両方揃えること
const GACHA_EXPORT_ROW_LIMIT = 50000

type GachaExportRow = {
  redeemed_at: string
  user_twitch_username: string | null
  cards: { name: string; rarity: string } | { name: string; rarity: string }[] | null
  streamers: { twitch_display_name: string } | { twitch_display_name: string }[] | null
}

export async function getGachaExportRows(
  client: SupabaseClient<SupabaseAdminSchema>,
  params: {
    range: TimeRange
    username: string
    rarity: string
    from: string
    to: string
    streamerId?: string
  },
  env: Env
): Promise<GachaExportRow[]> {
  const { range, username, rarity, from, to, streamerId } = params

  if (getAnalysisDbDriver(env) === 'pg') {
    const { fromDate, toDateExclusive } = resolveGachaDateFilters({ range, from, to })
    return getGachaExportRowsPg(env, {
      streamerId,
      fromDate,
      toDateExclusive,
      usernameIlike: username ? `%${escapeIlikePattern(username)}%` : undefined,
      rarity: rarity || undefined,
    }) as Promise<GachaExportRow[]>
  }

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
      query = query.ilike('user_twitch_username', `%${escapeIlikePattern(username)}%`)
    }

    if (rarity) {
      // getGachaTable()と同じ理由: バリデーションなしの既存挙動を維持したまま型だけ合わせる
      query = query.eq('cards.rarity', rarity as Rarity)
    }

    if (from) {
      query = query.gte('redeemed_at', `${from}T00:00:00Z`)
    }

    if (to) {
      query = query.lt('redeemed_at', computeExclusiveToDateIso(to))
    }

    // getGachaTableと同じ理由でid をタイブレーカーに追加(range()を跨ぐ全件取得のため
    // 同一redeemed_atの行が多いと安定ソートなしでは重複/欠落しうる)
    return query.order('redeemed_at', { ascending: false }).order('id', { ascending: false })
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
  client: SupabaseClient<SupabaseAdminSchema>,
  url: URL,
  res: ServerResponse,
  env: Env
): Promise<void> {
  try {
    const range = parseTimeRange(url.searchParams.get('range'))
    const username = url.searchParams.get('username') || ''
    const rarity = url.searchParams.get('rarity') || ''
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''
    const streamerId = url.searchParams.get('streamerId') || undefined

    const rows = await getGachaExportRows(
      client,
      { range, username, rarity, from, to, streamerId },
      env
    )
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
export async function getDropRateStats(
  client: SupabaseClient<SupabaseAdminSchema>,
  params: { streamerId: string; range: TimeRange },
  env: Env
) {
  const fromDate = getFromDateForRange(params.range) ?? '1970-01-01T00:00:00Z'

  if (getAnalysisDbDriver(env) === 'pg') {
    return getDropRateStatsPg(env, {
      streamerId: params.streamerId,
      fromDate,
      limitPerCard: 20,
    })
  }

  const { data, error } = await client.rpc('get_gacha_drop_stats' as never, {
    p_streamer_id: params.streamerId,
    p_from_date: fromDate,
    p_limit_per_card: 20,
  } as never)
  if (error) throw error
  return data
}

// analysis/src/pages/UserCards.tsx の :userId (内部users.id) からユーザーとカード所持サマリーを返す
export async function getUserCardsSummary(client: SupabaseClient<SupabaseAdminSchema>, userId: string, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return getUserCardsSummaryPg(env, userId)
  }

  // select('*') は使わない（USER_SAFE_COLUMNSの定義コメント参照: OAuthトークン漏洩防止）
  const { data: user, error } = await client
    .from('users')
    .select(USER_SAFE_COLUMNS)
    .eq('id', userId)
    .single()
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
export async function getUserCardsTable(
  client: SupabaseClient<SupabaseAdminSchema>,
  params: { userId: string; page: number; pageSize: number },
  env: Env
) {
  const { userId, page, pageSize } = params
  const offset = (page - 1) * pageSize

  if (getAnalysisDbDriver(env) === 'pg') {
    return getUserCardsTablePg(env, { userId, offset, pageSize })
  }

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
export async function getStreamerCardsPage(
  client: SupabaseClient<SupabaseAdminSchema>,
  params: { streamerId: string; page: number; pageSize: number },
  env: Env
) {
  const { streamerId, page, pageSize } = params
  const offset = (page - 1) * pageSize

  if (getAnalysisDbDriver(env) === 'pg') {
    return getStreamerCardsPagePg(env, { streamerId, offset, pageSize })
  }

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

export async function createAnnouncement(client: SupabaseClient<SupabaseAdminSchema>, body: unknown, env: Env) {
  const payload = announcementPayload(body)
  if (getAnalysisDbDriver(env) === 'pg') {
    return createAnnouncementPg(env, payload)
  }
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

export async function updateAnnouncement(
  client: SupabaseClient<SupabaseAdminSchema>,
  id: string,
  body: unknown,
  env: Env
) {
  const payload = requireObject(body)
  const update =
    'title' in payload || 'body' in payload || 'severity' in payload
      ? announcementPayload(body)
      : {
          is_published: !!payload.is_published,
          updated_at: new Date().toISOString(),
        }

  if (getAnalysisDbDriver(env) === 'pg') {
    return updateAnnouncementPg(env, id, update)
  }

  const { data, error } = await client
    .from('announcements')
    .update(update as never)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error

  const { count, error: countError } = await client
    .from('announcement_reads')
    .select('id', { count: 'exact', head: true })
    .eq('announcement_id', id)
  if (countError) throw countError

  return {
    ...data,
    read_count: count || 0,
  }
}

export async function deleteAnnouncement(client: SupabaseClient<SupabaseAdminSchema>, id: string, env: Env) {
  if (getAnalysisDbDriver(env) === 'pg') {
    return deleteAnnouncementPg(env, id)
  }
  const { error } = await client.from('announcements').delete().eq('id', id)
  if (error) throw error
  return { ok: true }
}

async function handleRoute(ctx: RouteContext): Promise<unknown> {
  const { client, req, url, body, env } = ctx
  const path = url.pathname.replace(/^\/__admin/, '')

  if (req.method === 'GET' && path === '/overview') {
    return getOverview(client, env)
  }

  // getStreamerLeaderboard()は直近30日のgacha_history全件(~65,000行超)をfetchAllPagedで
  // ページングして集計するため20秒前後かかる。getOverview()と分離し、Overviewページ側で
  // 独立ロードできるようにする(他の統計をブロックしないため)
  if (req.method === 'GET' && path === '/overview/leaderboard') {
    return getStreamerLeaderboard(client, env)
  }

  if (req.method === 'GET' && path === '/users') {
    return listUsers(client, env)
  }

  if (req.method === 'GET' && path === '/streamers') {
    return listStreamersWithStats(client, env)
  }

  const streamerByIdMatch = path.match(/^\/streamers\/([^/]+)$/)
  if (req.method === 'GET' && streamerByIdMatch) {
    return getStreamerById(client, streamerByIdMatch[1], env)
  }

  if (req.method === 'GET' && path === '/gacha/chart') {
    const range = parseTimeRange(url.searchParams.get('range'))
    const streamerId = url.searchParams.get('streamerId') || undefined
    return getGachaChart(client, { range, streamerId }, env)
  }

  if (req.method === 'GET' && path === '/gacha/summary') {
    const range = parseTimeRange(url.searchParams.get('range'))
    const streamerId = url.searchParams.get('streamerId') || undefined
    return getGachaSummary(client, { range, streamerId }, env)
  }

  if (req.method === 'GET' && path === '/gacha/table') {
    const range = parseTimeRange(url.searchParams.get('range'))
    const { page, pageSize } = parsePagination(url)
    const username = url.searchParams.get('username') || ''
    const rarity = url.searchParams.get('rarity') || ''
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''
    const streamerId = url.searchParams.get('streamerId') || undefined
    return getGachaTable(
      client,
      { range, page, pageSize, username, rarity, from, to, streamerId },
      env
    )
  }

  if (req.method === 'GET' && path === '/drop-rate-stats') {
    const streamerId = url.searchParams.get('streamerId')
    if (!streamerId) {
      throw Object.assign(new Error('streamerId is required'), { statusCode: 400 })
    }
    const range = parseTimeRange(url.searchParams.get('range'))
    return getDropRateStats(client, { streamerId, range }, env)
  }

  if (req.method === 'GET' && path === '/user-cards/summary') {
    const userId = url.searchParams.get('userId')
    if (!userId) {
      throw Object.assign(new Error('userId is required'), { statusCode: 400 })
    }
    return getUserCardsSummary(client, userId, env)
  }

  if (req.method === 'GET' && path === '/user-cards/table') {
    const userId = url.searchParams.get('userId')
    if (!userId) {
      throw Object.assign(new Error('userId is required'), { statusCode: 400 })
    }
    const { page, pageSize } = parsePagination(url)
    return getUserCardsTable(client, { userId, page, pageSize }, env)
  }

  if (req.method === 'GET' && path === '/streamer-cards') {
    const streamerId = url.searchParams.get('streamerId')
    if (!streamerId) {
      throw Object.assign(new Error('streamerId is required'), { statusCode: 400 })
    }
    const { page, pageSize } = parsePagination(url)
    return getStreamerCardsPage(client, { streamerId, page, pageSize }, env)
  }

  if (req.method === 'GET' && path === '/support-codes') {
    return listSupportCodes(client, env)
  }

  if (req.method === 'POST' && path === '/support-codes') {
    const payload = requireObject(body)
    return createSupportCode(client, payload, env)
  }

  const supportCodeMatch = path.match(/^\/support-codes\/([^/]+)$/)
  if (req.method === 'PATCH' && supportCodeMatch) {
    const payload = requireObject(body)
    return updateSupportCodeStatus(client, supportCodeMatch[1], payload.status, env)
  }

  const revokeMatch = path.match(/^\/support-codes\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    return revokeSupportCode(client, revokeMatch[1], env)
  }

  if (req.method === 'GET' && path === '/licenses') {
    return listLicenses(client, env)
  }

  if (req.method === 'GET' && path === '/twitch-subs') {
    return listTwitchSubs(client, env)
  }

  if (req.method === 'GET' && path === '/support-inquiries') {
    const status = url.searchParams.get('status') || 'all'
    return getSupportInquiries(client, status, env)
  }

  if (req.method === 'GET' && path === '/announcements') {
    return listAnnouncements(client, env)
  }

  if (req.method === 'POST' && path === '/announcements') {
    return createAnnouncement(client, body, env)
  }

  const announcementMatch = path.match(/^\/announcements\/([^/]+)$/)
  if (announcementMatch && req.method === 'PATCH') {
    return updateAnnouncement(client, announcementMatch[1], body, env)
  }

  if (announcementMatch && req.method === 'DELETE') {
    return deleteAnnouncement(client, announcementMatch[1], env)
  }

  const inquiryMatch = path.match(/^\/support-inquiries\/([^/]+)$/)
  if (req.method === 'PATCH' && inquiryMatch) {
    const payload = requireObject(body)
    return updateSupportInquiryStatus(client, inquiryMatch[1], payload.status, env)
  }

  const messagesMatch = path.match(/^\/support-inquiries\/([^/]+)\/messages$/)
  if (messagesMatch && req.method === 'GET') {
    return listSupportInquiryMessages(client, messagesMatch[1], env)
  }

  if (messagesMatch && req.method === 'POST') {
    const payload = requireObject(body)
    return createSupportInquiryMessage(client, messagesMatch[1], String(payload.body || '').trim(), env)
  }

  throw Object.assign(new Error('Admin API route not found'), { statusCode: 404 })
}

export function localAdminApiPlugin(env: Env): Plugin {
  let client: SupabaseClient<SupabaseAdminSchema> | null = null

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
          // pgドライバ時はSupabaseクライアントを構築せず、代わりにsentinelを使う
          // （全ルートラッパーはpg分岐で client に触れず xxxPg(env, ...) に委譲する。
          // 詳細は createSupabaseClientAccessSentinel() のコメント参照）。
          if (getAnalysisDbDriver(env) !== 'pg') {
            client ||= getSupabaseClient(env)
          } else {
            client ||= createSupabaseClientAccessSentinel()
          }

          // CSVを返すエクスポート用ルートはJSON専用のhandleRoute()+sendJson()の
          // 汎用ディスパッチに乗せられないため、ここで先取りして個別処理する。
          // connectのミドルウェアマウント('/__admin')によりreq.url/url.pathnameからは
          // 既に/__adminプレフィックスが取り除かれている点に注意（handleRoute内のpath
          // 変換と同様）
          if (req.method === 'GET' && url.pathname === '/gacha/export') {
            await handleGachaExport(client, url, res, env)
            return
          }

          const body = await readBody(req)
          const result = await handleRoute({ req, res, client, body, url, env })
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
