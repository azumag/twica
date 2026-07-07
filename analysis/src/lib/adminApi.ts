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
interface LicenseWithUser extends UserLicense {
  twitch_username?: string
}

interface TwitchSubUser {
  twitch_user_id: string
  twitch_display_name: string
  twitch_sub_verified_at: string | null
}

interface AnnouncementWithStats extends Announcement {
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

type AdminApiError = {
  error?: string
  details?: unknown
}

export type TimeRange = '7d' | '30d' | '90d' | 'all'

export interface Paginated<T> {
  rows: T[]
  count: number
}

// analysis/src/pages/Users.tsx の fetchUsers() が読む形（user.user_cards?.[0]?.count）と一致
export type UserWithCardCount = User & { user_cards: { count: number }[] }

// analysis/src/pages/Streamers.tsx の StreamerWithStats と同じ形
export interface StreamerWithStats extends Streamer {
  card_count: number
  storage_bytes: number
  has_chat_scope: boolean
  chat_send_available: boolean
  has_active_bot_sender: boolean
  chat_sender_mode: 'streamer' | 'custom_bot' | 'official_bot'
  has_vote_campaign_bonus: boolean
}

// チャート用ガチャ履歴行 - cards は最小フィールドのみ
export type GachaChartCard = Pick<Card, 'id' | 'name' | 'rarity' | 'image_url'>

export interface GachaChartRow {
  id: string
  redeemed_at: string
  card_id: string
  user_twitch_id: string
  streamer_id: string
  cards: GachaChartCard | null
  streamers: Streamer | null
}

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/__admin${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  })

  if (!response.ok) {
    let payload: AdminApiError | undefined
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }
    throw new Error(payload?.error || `Admin API request failed: ${response.status}`)
  }

  return response.json() as Promise<T>
}

export const adminApi = {
  getOverview: () => request<OverviewData>('/overview'),
  getOverviewLeaderboard: () => request<StreamerLeaderboardEntry[]>('/overview/leaderboard'),
  getUsers: () => request<UserWithCardCount[]>('/users'),
  getStreamers: () => request<StreamerWithStats[]>('/streamers'),
  getGachaChart: (params: { range: TimeRange; streamerId?: string }) =>
    request<GachaChartRow[]>(`/gacha/chart?${buildQueryString(params)}`),
  getGachaSummary: (params: { range: TimeRange; streamerId?: string }) =>
    request<GachaSummary>(`/gacha/summary?${buildQueryString(params)}`),
  getGachaTable: (params: GachaTableParams) =>
    request<Paginated<GachaTableRow>>(`/gacha/table?${buildQueryString(params)}`),
  // CSVを返すエンドポイントなのでrequest<T>()は使わず、URLだけ組み立てて返す。
  // 実際のダウンロード発火（location遷移などDOM副作用）は呼び出し側（ページ）の責務とする
  getGachaExportUrl: (params: GachaExportParams) =>
    `/__admin/gacha/export?${buildQueryString(params)}`,
  getDropRateStats: (params: { streamerId: string; range: TimeRange }) =>
    request<DropRateStatsResponse>(`/drop-rate-stats?${buildQueryString(params)}`),
  getUserCardsSummary: (userId: string) =>
    request<UserCardsSummary>(`/user-cards/summary?${buildQueryString({ userId })}`),
  getUserCardsTable: (params: { userId: string; page: number; pageSize: number }) =>
    request<Paginated<UserCardsTableRow>>(`/user-cards/table?${buildQueryString(params)}`),
  getStreamerCards: (params: { streamerId: string; page: number; pageSize: number }) =>
    request<Paginated<Card>>(`/streamer-cards?${buildQueryString(params)}`),
  getSupportCodes: () => request<SupportCode[]>('/support-codes'),
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
  getLicenses: () => request<LicenseWithUser[]>('/licenses'),
  getTwitchSubs: () => request<{ rows: TwitchSubUser[]; count: number }>('/twitch-subs'),
  getSupportInquiries: (status: string) =>
    request<SupportInquiry[]>(`/support-inquiries?status=${encodeURIComponent(status)}`),
  getSupportInquiryMessages: (inquiryId: string) =>
    request<SupportInquiryMessage[]>(`/support-inquiries/${inquiryId}/messages`),
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
  getAnnouncements: () => request<AnnouncementWithStats[]>('/announcements'),
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
