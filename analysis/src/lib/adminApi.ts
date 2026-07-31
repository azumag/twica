import type {
  Announcement,
  InquiryStatus,
  PlanType,
  SupportCode,
  SupportCodeStatus,
  SupportInquiry,
  SupportInquiryMessage,
  UserLicense,
  GachaHistory,
  Card,
  Streamer,
  User,
  Rarity,
} from '../types/database'
export interface LicenseWithUser extends UserLicense {
  twitch_username?: string
}

export interface TwitchSubUser {
  twitch_user_id: string
  twitch_display_name: string
  twitch_sub_verified_at: string | null
}

export interface AnnouncementWithStats extends Announcement {
  read_count: number
}

export interface OverviewStats {
  totalUsers: number
  totalStreamers: number
  totalCards: number
  todayGacha: number
  weekGacha: number
  monthGacha: number
}

export interface OverviewData {
  stats: OverviewStats
  recentGacha: (GachaHistory & { cards: Card | null; streamers: Streamer | null })[]
  userGrowth: { date: string; count: number }[]
  gachaGrowth: { date: string; count: number }[]
}

// GET /overview/leaderboard の1エントリ。/overview とは別の遅いエンドポイントとして
// 独立に取得する(analysis/src/pages/Overview.tsx で別useEffect/別loading state管理)
export interface StreamerLeaderboardEntry {
  streamerId: string
  displayName: string
  profileImageUrl: string | null
  drawCount: number
}

type AnnouncementInput = Pick<
  Announcement,
  'title' | 'body' | 'severity' | 'is_published' | 'published_at' | 'expires_at'
>

type AdminApiErrorPayload = {
  error?: string
  code?: string
  details?: unknown
}

/**
 * `/__admin` APIが返す構造化エラー。レスポンスJSON本文は`AdminApiErrorPayload`の
 * フラットな形（`{error: string, code?: string, details?: unknown}`、ネストしない）
 * を前提とする。#694（中央集約maintenance mode）が実装される場合、サーバー側は
 * この形に沿って`{error: '...', code: 'maintenance_read_only', details: {...}}`を
 * 返すことを想定している（現時点で#694は未実装のためそのcodeはまだ存在しない）。
 * ここでは特定のcode値をハードコードせず、サーバーが送ってきた`code`/`details`を
 * そのまま透過的に保持するだけに留める。これにより#694実装後もこのクラス自体の
 * 変更は不要（呼び出し元がcodeで分岐する処理を追加するだけで済む）。
 *
 * `code: 'timeout'`は本ファイル内でクライアント側から合成する特別な値（サーバーが
 * 返すものではない）。`request()`のAbortSignalタイムアウト発火時に使う。
 */
export class AdminApiRequestError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message)
    this.name = 'AdminApiRequestError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export type TimeRange = '7d' | '30d' | '90d' | 'all'

export interface Paginated<T> {
  rows: T[]
  count: number
}

export interface PaginatedWithSummary<T, S> extends Paginated<T> {
  summary: S
}

// analysis/src/pages/Users.tsx の fetchUsers() が読む形（user.user_cards?.[0]?.count）と一致
export type UserWithCardCount = User & { user_cards: { count: number }[] }

// ストリーマーのカード統計とストレージ使用量を含む拡張型。analysis/src/pages/Streamers.tsxが使う
export interface StreamerWithStats extends Streamer {
  card_count: number
  // ストレージ使用量（バイト単位）- blob_filesのuser_prefix集計による実使用量
  storage_bytes: number
  // usersテーブルのtwitch_scopesにuser:write:chatが含まれているか
  // チャット通知の送信にはこのスコープが必要
  has_chat_scope: boolean
  // 現在の送信方式（配信者本人 / BOT）でチャット通知を送信できるか
  chat_send_available: boolean
  // 有効なBOT送信設定があるか
  has_active_bot_sender: boolean
  // 現在選択されているチャット通知の送信方式
  chat_sender_mode: 'streamer' | 'custom_bot' | 'official_bot'
  // 投票キャンペーンボーナスを有効化しているか
  has_vote_campaign_bonus: boolean
}

export type UserListSortOrder =
  | 'card_count_desc'
  | 'card_count_asc'
  | 'created_at_desc'
  | 'name_asc'

export type StreamerListSortOrder =
  | 'card_count_desc'
  | 'card_count_asc'
  | 'created_at_desc'
  | 'name_asc'
  | 'storage_desc'

export interface UserListSummary {
  totalUsers: number
  totalCards: number
  usersWithTos: number
  usersWithCards: number
}

export interface StreamerListSummary {
  totalStreamers: number
  activeStreamers: number
  configuredStreamers: number
  totalCards: number
  totalStorage: number
  streamersWithCards: number
  chatEnabledStreamers: number
  customTemplateStreamers: number
  chatEnabledNoSender: number
  voteCampaignUsers: number
}

export interface StreamerOption {
  id: string
  twitch_username: string
  twitch_display_name: string
}

export type UserListResponse = PaginatedWithSummary<UserWithCardCount, UserListSummary>
export type StreamerListResponse = PaginatedWithSummary<StreamerWithStats, StreamerListSummary>

export interface UserListParams {
  page: number
  pageSize: number
  search?: string
  sort?: UserListSortOrder
  hideZeroCards?: boolean
}

export interface StreamerListParams {
  page: number
  pageSize: number
  search?: string
  sort?: StreamerListSortOrder
  hideZeroCards?: boolean
  filterChatEnabled?: boolean
  filterHasTemplate?: boolean
  filterMissingScope?: boolean
  filterVoteCampaign?: boolean
}

export interface StreamerOptionParams {
  page: number
  pageSize: number
  search?: string
}

// DB側集計RPCが返す人気カードの最小フィールド
export type GachaChartCard = Pick<Card, 'id' | 'name' | 'rarity' | 'image_url'>

export interface GachaSummary {
  totalGacha: number
  uniqueUsers: number
  legendaryCount: number
  dailyGachaData: { date: string; count: number }[]
  rarityDistribution: { name: string; value: number; rarity: Rarity }[]
  popularCards: { card: GachaChartCard; count: number }[]
}

// テーブル用ガチャ履歴行 - cards/streamers はフルレコード
export interface GachaTableRow extends GachaHistory {
  cards: Card | null
  streamers: Streamer | null
}

// buildQueryStringにそのまま渡すため、interfaceではなくobject literal型として定義する
// (interfaceにはTypeScriptの暗黙のindexシグネチャが付与されずRecord<string,...>に代入できないため)
export type GachaTableParams = {
  range: TimeRange
  page: number
  pageSize: number
  username?: string
  rarity?: Rarity | ''
  from?: string
  to?: string
  streamerId?: string
}

// getGachaTableと同じフィルタだが、CSVエクスポートはページネーションされないため
// page/pageSizeを持たない
export type GachaExportParams = Omit<GachaTableParams, 'page' | 'pageSize'>

// get_gacha_drop_stats RPCの戻り値(JSONB)の形をそのまま反映
export interface DropRateDrawer {
  user_twitch_id: string
  username: string
  draw_count: number
  last_drawn_at: string
}

export interface DropRateCardStat {
  card_id: string
  card_name: string
  rarity: Rarity
  image_url: string | null
  configured_rate: number
  actual_count: number
  actual_rate: number
  drawer_count: number
  drawers: DropRateDrawer[]
}

export interface DropRateRarityStat {
  rarity: string
  count: number
  rate: number
}

export interface DropRateStatsResponse {
  total_draws: number
  card_stats: DropRateCardStat[]
  rarity_stats: DropRateRarityStat[]
}

// get_user_card_counts RPCの戻り値（配列）の1エントリ
export interface UserCardCountEntry {
  count: number
  card: Card
  streamer: Streamer
}

export interface UserCardsSummary {
  user: User
  cardCounts: UserCardCountEntry[]
}

export interface UserCardsTableRow {
  id: string
  card_id: string
  obtained_at: string
  cards: Card | null
  streamer: Streamer | null
}

// undefined/空文字のパラメータを除外してクエリ文字列を組み立てる
function buildQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  return search.toString()
}

// リクエストがハングしたまま返ってこない事故(サーバープロセスの停止・ネットワーク
// 断等)を防ぐデフォルトタイムアウト。Overviewや一覧の集計はDB側で完結するが、
// ネットワーク障害やDBの一時的な遅延でリクエストが無期限に残らないよう、
// UIが再試行できる十分な余裕を持たせた値にする。
const DEFAULT_TIMEOUT_MS = 60_000

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/__admin${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
      // 呼び出し元が独自のsignal(例: コンポーネントunmount時のキャンセル)を渡した場合、
      // それで単純に上書きすると既定のタイムアウト保護が消えてしまう(呼び出し元の
      // signalさえabortしなければ、ハングしたリクエストが無期限に残る)。
      // AbortSignal.anyでどちらか早く発火した方を採用し、両方の保護を両立させる
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
        : AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
  } catch (error) {
    // AbortSignal.timeout()発火時、fetchは name='TimeoutError' のDOMExceptionでreject
    // する(呼び出し元が自前のAbortControllerで能動的に中断した場合の name='AbortError'
    // とは区別される)。ここを素通しするとブラウザ依存の低レベル英語メッセージが
    // そのままUIに出て、かつ他のエラーと違いAdminApiRequestErrorでも無いため
    // 呼び出し元がタイムアウトかどうか判別できない。構造化エラーの枠に正規化する
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new AdminApiRequestError(
        `Admin APIへのリクエストがタイムアウトしました(${DEFAULT_TIMEOUT_MS / 1000}秒)`,
        0,
        'timeout'
      )
    }
    throw error
  }

  if (!response.ok) {
    let payload: AdminApiErrorPayload | undefined
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    throw new AdminApiRequestError(
      payload?.error || `Admin API request failed: ${response.status}`,
      response.status,
      payload?.code,
      payload?.details
    )
  }

  return response.json() as Promise<T>
}

// 呼び出し元(ページのuseEffect)がAbortControllerで能動的にキャンセルできるように、
// 読み取り系メソッドは末尾に`options?: RequestOptions`を受け取る。書き込み系
// (POST/PATCH/DELETE)は今回signal対応の対象外(#701 UI state/UXの後続増分で
// 必要になれば追加する。ミューテーションの中断はロールバック考慮が要るため
// 読み取り系より慎重な検討が必要)。
export interface RequestOptions {
  signal?: AbortSignal
}

export const adminApi = {
  getOverview: (options?: RequestOptions) => request<OverviewData>('/overview', options),
  getOverviewLeaderboard: (options?: RequestOptions) =>
    request<StreamerLeaderboardEntry[]>('/overview/leaderboard', options),
  getUsers: (params: UserListParams = { page: 1, pageSize: 20 }, options?: RequestOptions) =>
    request<UserListResponse>(`/users?${buildQueryString({
      ...params,
      search: params.search?.trim() || undefined,
      sort: params.sort || 'card_count_desc',
      hideZeroCards: params.hideZeroCards ? 'true' : undefined,
    })}`, options),
  getStreamers: (
    params: StreamerListParams = { page: 1, pageSize: 20 },
    options?: RequestOptions
  ) =>
    request<StreamerListResponse>(`/streamers?${buildQueryString({
      ...params,
      search: params.search?.trim() || undefined,
      sort: params.sort || 'card_count_desc',
      hideZeroCards: params.hideZeroCards ? 'true' : undefined,
      filterChatEnabled: params.filterChatEnabled ? 'true' : undefined,
      filterHasTemplate: params.filterHasTemplate ? 'true' : undefined,
      filterMissingScope: params.filterMissingScope ? 'true' : undefined,
      filterVoteCampaign: params.filterVoteCampaign ? 'true' : undefined,
    })}`, options),
  getStreamerOptions: (params: StreamerOptionParams, options?: RequestOptions) =>
    request<Paginated<StreamerOption>>(`/streamers/options?${buildQueryString({
      page: params.page,
      pageSize: params.pageSize,
      search: params.search,
    })}`, options),
  getStreamer: (id: string, options?: RequestOptions) =>
    request<Streamer>(`/streamers/${id}`, options),
  getGachaSummary: (params: { range: TimeRange; streamerId?: string }, options?: RequestOptions) =>
    request<GachaSummary>(`/gacha/summary?${buildQueryString(params)}`, options),
  getGachaTable: (params: GachaTableParams, options?: RequestOptions) =>
    request<Paginated<GachaTableRow>>(`/gacha/table?${buildQueryString(params)}`, options),
  // CSVを返すエンドポイントなのでrequest<T>()は使わず、URLだけ組み立てて返す。
  // 実際のダウンロード発火（location遷移などDOM副作用）は呼び出し側（ページ）の責務とする
  getGachaExportUrl: (params: GachaExportParams) =>
    `/__admin/gacha/export?${buildQueryString(params)}`,
  getDropRateStats: (params: { streamerId: string; range: TimeRange }, options?: RequestOptions) =>
    request<DropRateStatsResponse>(`/drop-rate-stats?${buildQueryString(params)}`, options),
  getUserCardsSummary: (userId: string, options?: RequestOptions) =>
    request<UserCardsSummary>(`/user-cards/summary?${buildQueryString({ userId })}`, options),
  getUserCardsTable: (
    params: { userId: string; page: number; pageSize: number },
    options?: RequestOptions
  ) => request<Paginated<UserCardsTableRow>>(`/user-cards/table?${buildQueryString(params)}`, options),
  getStreamerCards: (
    params: { streamerId: string; page: number; pageSize: number },
    options?: RequestOptions
  ) => request<Paginated<Card>>(`/streamer-cards?${buildQueryString(params)}`, options),
  getSupportCodes: (options?: RequestOptions) => request<SupportCode[]>('/support-codes', options),
  createSupportCode: (input: { code_hash: string; plan_type: PlanType; memo: string | null }) =>
    request<SupportCode>('/support-codes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateSupportCodeStatus: (id: string, status: SupportCodeStatus) =>
    request<SupportCode>(`/support-codes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  revokeSupportCode: (id: string) =>
    request<{ ok: true }>(`/support-codes/${id}/revoke`, {
      method: 'POST',
    }),
  getLicenses: (options?: RequestOptions) => request<LicenseWithUser[]>('/licenses', options),
  getTwitchSubs: (options?: RequestOptions) =>
    request<{ rows: TwitchSubUser[]; count: number }>('/twitch-subs', options),
  getSupportInquiries: (status: string, options?: RequestOptions) =>
    request<SupportInquiry[]>(`/support-inquiries?status=${encodeURIComponent(status)}`, options),
  getSupportInquiryMessages: (inquiryId: string, options?: RequestOptions) =>
    request<SupportInquiryMessage[]>(`/support-inquiries/${inquiryId}/messages`, options),
  updateSupportInquiryStatus: (id: string, status: InquiryStatus) =>
    request<SupportInquiry>(`/support-inquiries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  createSupportInquiryReply: (inquiryId: string, body: string) =>
    request<SupportInquiryMessage>(`/support-inquiries/${inquiryId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  getAnnouncements: (options?: RequestOptions) =>
    request<AnnouncementWithStats[]>('/announcements', options),
  createAnnouncement: (input: AnnouncementInput) =>
    request<AnnouncementWithStats>('/announcements', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAnnouncement: (id: string, input: AnnouncementInput) =>
    request<AnnouncementWithStats>(`/announcements/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  updateAnnouncementPublished: (id: string, isPublished: boolean) =>
    request<AnnouncementWithStats>(`/announcements/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        is_published: isPublished,
      }),
    }),
  deleteAnnouncement: (id: string) =>
    request<{ ok: true }>(`/announcements/${id}`, {
      method: 'DELETE',
    }),
}
