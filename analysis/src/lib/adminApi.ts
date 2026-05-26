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
  Battle,
  Card,
  Streamer,
} from '../types/database'
import type { StreamerChatAccess } from './chatAnnouncementAccess'

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
  recentBattles: Battle[]
}

type AnnouncementInput = Pick<
  Announcement,
  'title' | 'body' | 'severity' | 'is_published' | 'published_at' | 'expires_at'
>

type AdminApiError = {
  error?: string
  details?: unknown
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
  getStreamerChatAccess: () => request<StreamerChatAccess[]>('/streamer-chat-access'),
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
