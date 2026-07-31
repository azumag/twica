import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import {
  createAnnouncementPg,
  createSupportCodePg,
  createSupportInquiryMessagePg,
  deleteAnnouncementPg,
  getDropRateStatsPg,
  getGachaExportRowsPg,
  getGachaSummaryPg,
  getGachaTablePg,
  getOverviewPg,
  getStreamerByIdPg,
  getStreamerCardsPagePg,
  getStreamerLeaderboardPg,
  getStreamersSummaryPg,
  getSupportInquiriesPg,
  getUserCardsSummaryPg,
  getUserCardsTablePg,
  listAnnouncementsPg,
  listLicensesPg,
  getStreamerOptionsPg,
  listStreamersWithStatsPg,
  listSupportCodesPg,
  listSupportInquiryMessagesPg,
  listTwitchSubsPg,
  listUsersPg,
  getUsersSummaryPg,
  revokeSupportCodePg,
  updateAnnouncementPg,
  updateSupportCodeStatusPg,
  updateSupportInquiryStatusPg,
} from './adminApiPg'
import { MAX_ANALYSIS_PAGE } from '../src/lib/pagination'

type Env = Record<string, string>

type TimeRange = '7d' | '30d' | '90d' | 'all'
type UserListSortOrder = 'card_count_desc' | 'card_count_asc' | 'created_at_desc' | 'name_asc'
type StreamerListSortOrder =
  | 'card_count_desc'
  | 'card_count_asc'
  | 'created_at_desc'
  | 'name_asc'
  | 'storage_desc'

type RouteContext = {
  req: IncomingMessage
  url: URL
  body: unknown
  env: Env
}

function isLoopback(remoteAddress: string | undefined): boolean {
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  )
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

function requireObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be a JSON object')
  }
  return body as Record<string, unknown>
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
  // ガチャ画面の初期表示は直近7日を基準にする。期間未指定を全期間に
  // フォールバックすると、古い履歴が増えるほど集計・テーブルの初回コストが
  // 増えるため、明示的に「全期間」を選んだ場合だけ all を許可する。
  if (raw === null) return '7d'
  if ((VALID_TIME_RANGES as readonly string[]).includes(raw))
    return raw as TimeRange
  throw Object.assign(new Error(`Invalid range: ${raw}`), { statusCode: 400 })
}

// page/pageSizeが未検証だと負のOFFSETや過大なLIMITがDBまで届く。
// 予測可能な4xxへ正規化し、DBドライバ由来のエラーを露出させない。
//
// ページ番号にも上限を設ける。ページ番号を無制限に受け入れると、例えば
// page=2147483648 が PostgreSQL の INTEGER 引数へ到達して500になったり、
// 有効な整数でも巨大な OFFSET のためにDBが大量行を読み飛ばす。管理画面の
// 一覧は「全件を取り切るAPI」ではなくbounded pageを返すAPIなので、現実的な
// 上限を超える要求は、深いOFFSETを実行する前に明示的な400として拒否する。
export function parsePagination(
  url: URL,
  maxPageSize = 1000,
  maxPage = MAX_ANALYSIS_PAGE
): { page: number; pageSize: number } {
  const page = Number(url.searchParams.get('page') || '1')
  const pageSize = Number(url.searchParams.get('pageSize') || '20')
  if (!Number.isSafeInteger(page) || page < 1 || page > maxPage) {
    throw Object.assign(new Error(`page must be a safe integer from 1 to ${maxPage}`), {
      statusCode: 400,
    })
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw Object.assign(
      new Error(`pageSize must be a positive integer up to ${maxPageSize}`),
      {
        statusCode: 400,
      }
    )
  }
  return { page, pageSize }
}

function parseBooleanParam(raw: string | null): boolean {
  if (raw === null || raw === '') return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw Object.assign(new Error(`Invalid boolean: ${raw}`), { statusCode: 400 })
}

function parseUserListSort(raw: string | null): UserListSortOrder {
  const value = raw || 'card_count_desc'
  const valid: readonly UserListSortOrder[] = [
    'card_count_desc',
    'card_count_asc',
    'created_at_desc',
    'name_asc',
  ]
  if (!valid.includes(value as UserListSortOrder)) {
    throw Object.assign(new Error(`Invalid user sort: ${value}`), { statusCode: 400 })
  }
  return value as UserListSortOrder
}

function parseStreamerListSort(raw: string | null): StreamerListSortOrder {
  const value = raw || 'card_count_desc'
  const valid: readonly StreamerListSortOrder[] = [
    'card_count_desc',
    'card_count_asc',
    'created_at_desc',
    'name_asc',
    'storage_desc',
  ]
  if (!valid.includes(value as StreamerListSortOrder)) {
    throw Object.assign(new Error(`Invalid streamer sort: ${value}`), { statusCode: 400 })
  }
  return value as StreamerListSortOrder
}

export async function listLicenses(env: Env) {
  return listLicensesPg(env)
}

export async function listSupportCodes(env: Env) {
  return listSupportCodesPg(env)
}

export async function createSupportCode(
  payload: Record<string, unknown>,
  env: Env
) {
  return createSupportCodePg(env, {
    codeHash: String(payload.code_hash || ''),
    planType: payload.plan_type,
    memo: payload.memo || null,
  })
}

export async function updateSupportCodeStatus(
  id: string,
  status: unknown,
  env: Env
) {
  return updateSupportCodeStatusPg(env, { id, status })
}

export async function revokeSupportCode(codeId: string, env: Env) {
  return revokeSupportCodePg(env, codeId)
}

export async function listTwitchSubs(env: Env) {
  return listTwitchSubsPg(env)
}

export async function getSupportInquiries(status: string, env: Env) {
  return getSupportInquiriesPg(env, status)
}

export async function updateSupportInquiryStatus(
  id: string,
  status: unknown,
  env: Env
) {
  return updateSupportInquiryStatusPg(env, { id, status })
}

export async function listSupportInquiryMessages(inquiryId: string, env: Env) {
  return listSupportInquiryMessagesPg(env, inquiryId)
}

export async function createSupportInquiryMessage(
  inquiryId: string,
  messageBody: string,
  env: Env
) {
  return createSupportInquiryMessagePg(env, { inquiryId, body: messageBody })
}

export async function listAnnouncements(env: Env) {
  return listAnnouncementsPg(env)
}

// 直近30日の配信者別ガチャ数トップ10を返す。集計は
// get_analysis_streamer_leaderboard() がDB側で行い、関数未適用時は#700の
// fail-fast方針に従ってエラーをそのまま返す。
export async function getStreamerLeaderboard(env: Env) {
  return getStreamerLeaderboardPg(env)
}

// overview統計（ユーザー数・配信者数・カード数・期間別ガチャ数・直近ガチャ・日次成長）を
// 返す。集計は get_analysis_overview()（00073_add_analysis_dashboard_rpcs.sql）が
// DB側で行う。関数未適用を遅いNode側集計で隠さず、#700のfail-fast方針に従う。
export async function getOverview(env: Env) {
  return getOverviewPg(env)
}

// analysis/src/pages/Users.tsx の fetchUsers() が期待する形と揃える
// (user.user_cards?.[0]?.count ?? 0 で件数を取り出すマッピングがそのまま動く形)
//
// select('*') は使わない: users テーブルには twitch_access_token / twitch_refresh_token
// などのOAuth秘匿情報が実カラムとして存在するため、admin API のJSONレスポンスに
// 含めないよう、フロントが使う列だけを明示的に指定する
// exportはテストのため（adminApiPg.ts の getUserCardsSummaryPg が同じ列集合を
// 独立に jsonb_build_object() として持つため、テストで両者の列集合一致を検証する）
export const USER_SAFE_COLUMNS =
  'id, twitch_user_id, twitch_username, twitch_display_name, twitch_profile_image_url, tos_accepted_at, twitch_scopes, created_at, updated_at'

// ユーザー一覧はDB側で検索・集計・ページングを済ませ、現在ページと全体サマリーだけを返す。
// これによりNodeプロセスがusers全件を保持してからブラウザへ渡す経路を廃止する。
export async function listUsers(
  params: {
    page: number
    pageSize: number
    search?: string
    sort?: UserListSortOrder
    hideZeroCards?: boolean
  },
  env: Env
) {
  return listUsersPg(env, params)
}

// global summaryはページ移動と独立して一度だけ取得する。ページRPCへ同じ集計を
// 毎回含めると、現在ページだけを返す最適化の裏で全件集計が繰り返されるため、
// 専用RPCとして画面側にキャッシュ可能な境界を作る。
export async function getUsersSummary(env: Env) {
  return getUsersSummaryPg(env)
}

// Streamersも同じ契約に統一する。重いカード数・ストレージ・チャット設定の
// 集計はDB側で行うが、JSON化するのは要求されたページの行だけに限定する。
export async function listStreamersWithStats(
  params: {
    page: number
    pageSize: number
    search?: string
    sort?: StreamerListSortOrder
    hideZeroCards?: boolean
    filterChatEnabled?: boolean
    filterHasTemplate?: boolean
    filterMissingScope?: boolean
    filterVoteCampaign?: boolean
  },
  env: Env
) {
  return listStreamersWithStatsPg(env, params)
}

export async function getStreamersSummary(env: Env) {
  return getStreamersSummaryPg(env)
}

export async function getStreamerOptions(
  params: { page: number; pageSize: number; search?: string },
  env: Env
) {
  return getStreamerOptionsPg(env, params)
}

// #701: StreamerCards.tsx/StreamerGachaHistory.tsxのブラウザDB直接アクセスを
// /__admin API経由に置き換えるための単一ストリーマー取得エンドポイント。
//
// 意図的な挙動変化: 旧ブラウザ経路はanon/publishable key + RLSポリシー
// 「Active streamers are viewable by everyone」(USING (is_active = true)、
// 00001_initial_schema.sql)の制約下にあり、is_active=falseのstreamerは
// 0件（エラー表示）だった。この新経路はservice-role/pg直結のためinactiveな
// streamerも返す。管理ダッシュボードの`/streamers`一覧は元々is_activeを問わず
// 全件表示しているため、この単体取得もそれに揃える形の意図的な改善である
// （既存の一覧表示との一貫性が取れていなかった旧挙動の方が不整合だった）。
export async function getStreamerById(id: string, env: Env) {
  return getStreamerByIdPg(env, id)
}

export async function getGachaSummary(
  params: { range: TimeRange; streamerId?: string },
  env: Env
) {
  const fromDate = getFromDateForRange(params.range)

  return getGachaSummaryPg(env, {
    fromDate,
    streamerId: params.streamerId ?? null,
  })
}

// ILIKE 部分一致用のパターン文字エスケープ（\\/%/_）。
// テーブル表示とCSVエクスポートで同一の検索条件を保証する。
export function escapeIlikePattern(value: string): string {
  // バックスラッシュ自身を先にエスケープしないと、後続の %/_ 用エスケープが
  // 検索文字列中のバックスラッシュをLIKEの制御文字として解釈してしまう。
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// to（YYYY-MM-DD）を「翌日0時（exclusive上限）」のISO文字列に変換する。
// テーブル表示とCSVエクスポートで同一の日付境界を保証する。
export function computeExclusiveToDateIso(to: string): string {
  const nextDay = new Date(`${to}T00:00:00Z`)
  nextDay.setUTCDate(nextDay.getUTCDate() + 1)
  return nextDay.toISOString()
}

// getGachaTable/getGachaExportRowsの日付フィルタ計算を共通化する。
// 「from/toが両方未指定ならrangeを使う。片方でも指定されていればrangeは無視し、
// from/toをそれぞれ独立に適用する」という既存UI契約を維持する。
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
  const { range, page, pageSize, username, rarity, from, to, streamerId } =
    params

  const { fromDate, toDateExclusive } = resolveGachaDateFilters({
    range,
    from,
    to,
  })
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

// GET /__admin/gacha/export 用の行取得。getGachaTable()と同じフィルタロジックだが
// ページネーションなし・全件取得（安全のため50,000件上限）。取得する列も
// CSV出力に必要な最小限（redeemed_at / username / card名・レアリティ / streamer名）に絞る
//
type GachaExportRow = {
  redeemed_at: string
  user_twitch_username: string | null
  cards:
    | { name: string; rarity: string }
    | { name: string; rarity: string }[]
    | null
  streamers:
    | { twitch_display_name: string }
    | { twitch_display_name: string }[]
    | null
}

export async function getGachaExportRows(
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

  const { fromDate, toDateExclusive } = resolveGachaDateFilters({
    range,
    from,
    to,
  })
  return getGachaExportRowsPg(env, {
    streamerId,
    fromDate,
    toDateExclusive,
    usernameIlike: username ? `%${escapeIlikePattern(username)}%` : undefined,
    rarity: rarity || undefined,
  }) as Promise<GachaExportRow[]>
}

// SQL集約結果は互換性のためオブジェクトまたは単要素配列になりうる。
// どちらの形でも安全に最初の要素相当を取り出す。
function firstOf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

function buildGachaExportCsv(rows: GachaExportRow[]): string {
  const header = toCsvRow([
    'redeemed_at',
    'streamer',
    'username',
    'card_name',
    'rarity',
  ])
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
      { range, username, rarity, from, to, streamerId },
      env
    )
    const csv = buildGachaExportCsv(rows)

    res.statusCode = 200
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader(
      'content-disposition',
      'attachment; filename="gacha-export.csv"'
    )
    res.end(csv)
  } catch (error) {
    console.error('[local-admin-api]', error)
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
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
  params: { streamerId: string; range: TimeRange },
  env: Env
) {
  const fromDate = getFromDateForRange(params.range) ?? '1970-01-01T00:00:00Z'

  return getDropRateStatsPg(env, {
    streamerId: params.streamerId,
    fromDate,
    limitPerCard: 20,
  })
}

// analysis/src/pages/UserCards.tsx の :userId (内部users.id) からユーザーとカード所持サマリーを返す
export async function getUserCardsSummary(userId: string, env: Env) {
  return getUserCardsSummaryPg(env, userId)
}

// analysis/src/pages/UserCards.tsx が現在.range(0, 9999)で単発取得しているuser_cardsの
// サーバーサイドページネーション版。streamerは各カードのstreamer_idからまとめて引き当てて埋め込む
export async function getUserCardsTable(
  params: { userId: string; page: number; pageSize: number },
  env: Env
) {
  const { userId, page, pageSize } = params
  const offset = (page - 1) * pageSize

  return getUserCardsTablePg(env, { userId, offset, pageSize })
}

// analysis/src/pages/StreamerCards.tsx が現在.range(0, 9999)で単発取得しているcardsの
// サーバーサイドページネーション版。並び順(レアリティ降順→作成日降順)は既存と同一
export async function getStreamerCardsPage(
  params: { streamerId: string; page: number; pageSize: number },
  env: Env
) {
  const { streamerId, page, pageSize } = params
  const offset = (page - 1) * pageSize

  return getStreamerCardsPagePg(env, { streamerId, offset, pageSize })
}

function announcementPayload(body: unknown) {
  const payload = requireObject(body)
  return {
    title: String(payload.title || '').trim(),
    body: String(payload.body || '').trim(),
    severity: payload.severity || 'info',
    is_published: !!payload.is_published,
    published_at:
      typeof payload.published_at === 'string' ? payload.published_at : null,
    expires_at:
      typeof payload.expires_at === 'string' ? payload.expires_at : null,
    updated_at: new Date().toISOString(),
  }
}

export async function createAnnouncement(body: unknown, env: Env) {
  const payload = announcementPayload(body)

  return createAnnouncementPg(env, payload)
}

export async function updateAnnouncement(id: string, body: unknown, env: Env) {
  const payload = requireObject(body)
  const update =
    'title' in payload || 'body' in payload || 'severity' in payload
      ? announcementPayload(body)
      : {
          is_published: !!payload.is_published,
          updated_at: new Date().toISOString(),
        }

  return updateAnnouncementPg(env, id, update)
}

export async function deleteAnnouncement(id: string, env: Env) {
  return deleteAnnouncementPg(env, id)
}

async function handleRoute(ctx: RouteContext): Promise<unknown> {
  const { req, url, body, env } = ctx
  const path = url.pathname.replace(/^\/__admin/, '')

  if (req.method === 'GET' && path === '/overview') {
    return getOverview(env)
  }

  // leaderboardはoverviewとは別の集計関数を呼ぶため、独立ロードして一方の
  // DB失敗や遅延がもう一方の統計をブロックしないようにする。
  if (req.method === 'GET' && path === '/overview/leaderboard') {
    return getStreamerLeaderboard(env)
  }

  if (req.method === 'GET' && path === '/users') {
    const { page, pageSize } = parsePagination(url, 100)
    const rawSearch = url.searchParams.get('search')?.trim() || ''
    return listUsers(
      {
        page,
        pageSize,
        search: rawSearch ? `%${escapeIlikePattern(rawSearch)}%` : undefined,
        sort: parseUserListSort(url.searchParams.get('sort')),
        hideZeroCards: parseBooleanParam(url.searchParams.get('hideZeroCards')),
      },
      env
    )
  }

  if (req.method === 'GET' && path === '/users/summary') {
    return getUsersSummary(env)
  }

  if (req.method === 'GET' && path === '/streamers') {
    const { page, pageSize } = parsePagination(url, 100)
    const rawSearch = url.searchParams.get('search')?.trim() || ''
    return listStreamersWithStats(
      {
        page,
        pageSize,
        search: rawSearch ? `%${escapeIlikePattern(rawSearch)}%` : undefined,
        sort: parseStreamerListSort(url.searchParams.get('sort')),
        hideZeroCards: parseBooleanParam(url.searchParams.get('hideZeroCards')),
        filterChatEnabled: parseBooleanParam(url.searchParams.get('filterChatEnabled')),
        filterHasTemplate: parseBooleanParam(url.searchParams.get('filterHasTemplate')),
        filterMissingScope: parseBooleanParam(url.searchParams.get('filterMissingScope')),
        filterVoteCampaign: parseBooleanParam(url.searchParams.get('filterVoteCampaign')),
      },
      env
    )
  }

  if (req.method === 'GET' && path === '/streamers/summary') {
    return getStreamersSummary(env)
  }

  // Gachaの配信者選択肢は一覧全件ではなく、表示に必要な軽量な候補だけ取得する。
  // 検索入力がある場合も同じbounded endpointを使い、ドロップダウンのために
  // StreamerWithStats全体（カード数・ストレージ・Bot設定）を転送しない。
  if (req.method === 'GET' && path === '/streamers/options') {
    const { page, pageSize } = parsePagination(url, 100)
    const rawSearch = url.searchParams.get('search')?.trim() || ''
    return getStreamerOptions(
      {
        page,
        pageSize,
        search: rawSearch ? `%${escapeIlikePattern(rawSearch)}%` : undefined,
      },
      env
    )
  }

  const streamerByIdMatch = path.match(/^\/streamers\/([^/]+)$/)
  if (req.method === 'GET' && streamerByIdMatch) {
    return getStreamerById(streamerByIdMatch[1], env)
  }

  if (req.method === 'GET' && path === '/gacha/summary') {
    const range = parseTimeRange(url.searchParams.get('range'))
    const streamerId = url.searchParams.get('streamerId') || undefined
    return getGachaSummary({ range, streamerId }, env)
  }

  if (req.method === 'GET' && path === '/gacha/table') {
    const range = parseTimeRange(url.searchParams.get('range'))
    // ガチャ履歴テーブルも画面の選択肢（20/50/100）に合わせ、1回のレスポンスを
    // 最大100行に固定する。デフォルトの1000行上限をそのまま使うと、画面外から
    // 大きなpageSizeを指定した場合に「サーバー側ページング」でも過大取得できる。
    const { page, pageSize } = parsePagination(url, 100)
    const username = url.searchParams.get('username') || ''
    const rarity = url.searchParams.get('rarity') || ''
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || ''
    const streamerId = url.searchParams.get('streamerId') || undefined
    return getGachaTable(
      { range, page, pageSize, username, rarity, from, to, streamerId },
      env
    )
  }

  if (req.method === 'GET' && path === '/drop-rate-stats') {
    const streamerId = url.searchParams.get('streamerId')
    if (!streamerId) {
      throw Object.assign(new Error('streamerId is required'), {
        statusCode: 400,
      })
    }
    const range = parseTimeRange(url.searchParams.get('range'))
    return getDropRateStats({ streamerId, range }, env)
  }

  if (req.method === 'GET' && path === '/user-cards/summary') {
    const userId = url.searchParams.get('userId')
    if (!userId) {
      throw Object.assign(new Error('userId is required'), { statusCode: 400 })
    }
    return getUserCardsSummary(userId, env)
  }

  if (req.method === 'GET' && path === '/user-cards/table') {
    const userId = url.searchParams.get('userId')
    if (!userId) {
      throw Object.assign(new Error('userId is required'), { statusCode: 400 })
    }
    const { page, pageSize } = parsePagination(url)
    return getUserCardsTable({ userId, page, pageSize }, env)
  }

  if (req.method === 'GET' && path === '/streamer-cards') {
    const streamerId = url.searchParams.get('streamerId')
    if (!streamerId) {
      throw Object.assign(new Error('streamerId is required'), {
        statusCode: 400,
      })
    }
    const { page, pageSize } = parsePagination(url)
    return getStreamerCardsPage({ streamerId, page, pageSize }, env)
  }

  if (req.method === 'GET' && path === '/support-codes') {
    return listSupportCodes(env)
  }

  if (req.method === 'POST' && path === '/support-codes') {
    const payload = requireObject(body)
    return createSupportCode(payload, env)
  }

  const supportCodeMatch = path.match(/^\/support-codes\/([^/]+)$/)
  if (req.method === 'PATCH' && supportCodeMatch) {
    const payload = requireObject(body)
    return updateSupportCodeStatus(supportCodeMatch[1], payload.status, env)
  }

  const revokeMatch = path.match(/^\/support-codes\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    return revokeSupportCode(revokeMatch[1], env)
  }

  if (req.method === 'GET' && path === '/licenses') {
    return listLicenses(env)
  }

  if (req.method === 'GET' && path === '/twitch-subs') {
    return listTwitchSubs(env)
  }

  if (req.method === 'GET' && path === '/support-inquiries') {
    const status = url.searchParams.get('status') || 'all'
    return getSupportInquiries(status, env)
  }

  if (req.method === 'GET' && path === '/announcements') {
    return listAnnouncements(env)
  }

  if (req.method === 'POST' && path === '/announcements') {
    return createAnnouncement(body, env)
  }

  const announcementMatch = path.match(/^\/announcements\/([^/]+)$/)
  if (announcementMatch && req.method === 'PATCH') {
    return updateAnnouncement(announcementMatch[1], body, env)
  }

  if (announcementMatch && req.method === 'DELETE') {
    return deleteAnnouncement(announcementMatch[1], env)
  }

  const inquiryMatch = path.match(/^\/support-inquiries\/([^/]+)$/)
  if (req.method === 'PATCH' && inquiryMatch) {
    const payload = requireObject(body)
    return updateSupportInquiryStatus(inquiryMatch[1], payload.status, env)
  }

  const messagesMatch = path.match(/^\/support-inquiries\/([^/]+)\/messages$/)
  if (messagesMatch && req.method === 'GET') {
    return listSupportInquiryMessages(messagesMatch[1], env)
  }

  if (messagesMatch && req.method === 'POST') {
    const payload = requireObject(body)
    return createSupportInquiryMessage(
      messagesMatch[1],
      String(payload.body || '').trim(),
      env
    )
  }

  throw Object.assign(new Error('Admin API route not found'), {
    statusCode: 404,
  })
}

export function localAdminApiPlugin(env: Env): Plugin {
  return {
    name: 'twica-local-admin-api',
    configureServer(server) {
      server.middlewares.use('/__admin', async (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
          sendJson(res, 403, {
            error: 'Admin API is only available from loopback addresses',
          })
          return
        }

        const url = new URL(req.url || '/', 'http://localhost')

        try {
          // CSVを返すエクスポート用ルートはJSON専用のhandleRoute()+sendJson()の
          // 汎用ディスパッチに乗せられないため、ここで先取りして個別処理する。
          // connectのミドルウェアマウント('/__admin')によりreq.url/url.pathnameからは
          // 既に/__adminプレフィックスが取り除かれている点に注意（handleRoute内のpath
          // 変換と同様）
          if (req.method === 'GET' && url.pathname === '/gacha/export') {
            await handleGachaExport(url, res, env)
            return
          }

          const body = await readBody(req)
          const result = await handleRoute({ req, body, url, env })
          sendJson(res, 200, result)
        } catch (error) {
          const status =
            typeof (error as { statusCode?: unknown }).statusCode === 'number'
              ? (error as { statusCode: number }).statusCode
              : 500
          console.error('[local-admin-api]', error)
          sendJson(res, status, {
            error:
              error instanceof Error
                ? error.message
                : 'Admin API request failed',
          })
        }
      })
    },
  }
}
