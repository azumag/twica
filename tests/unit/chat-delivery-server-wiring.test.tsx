import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import DashboardLayout from '@/app/dashboard/layout'
import SettingsPage from '@/app/dashboard/settings/page'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
  getUnreadAnnouncements: vi.fn(),
  getUserPlanSnapshot: vi.fn(),
  getUserPlan: vi.fn(),
  getChatDeliveryCapability: vi.fn(),
  getStreamerData: vi.fn(),
  getCustomBotAccountDisplayForStreamer: vi.fn(),
  shouldShowVoteCampaign: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('@/lib/session', () => ({
  getSession: mocks.getSession,
  canUseStreamerFeatures: mocks.canUseStreamerFeatures,
}))

vi.mock('@/lib/announcements', () => ({
  getUnreadAnnouncements: mocks.getUnreadAnnouncements,
}))

vi.mock('@/lib/plan', () => ({
  getUserPlanSnapshot: mocks.getUserPlanSnapshot,
  getUserPlan: mocks.getUserPlan,
}))

vi.mock('@/lib/twitch/chat-delivery-capability', () => ({
  getChatDeliveryCapability: mocks.getChatDeliveryCapability,
}))

vi.mock('@/lib/dashboard-data', () => ({
  getStreamerData: mocks.getStreamerData,
}))

vi.mock('@/lib/twitch/token-manager', () => ({
  getCustomBotAccountDisplayForStreamer: mocks.getCustomBotAccountDisplayForStreamer,
}))

vi.mock('@/lib/storage-db', () => ({
  shouldShowVoteCampaign: mocks.shouldShowVoteCampaign,
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('@/lib/perf', () => ({
  perfStart: () => 0,
  logPerf: () => undefined,
}))

vi.mock('@/components/Header', () => ({ default: () => null }))
vi.mock('@/components/DashboardNav', () => ({ default: () => null }))
vi.mock('@/components/TwitchLoginRedirect', () => ({ TwitchLoginRedirect: () => null }))
vi.mock('@/components/MaintenanceBanner', () => ({ default: () => null }))
vi.mock('@/components/MaintenanceStatusProvider', () => ({
  MaintenanceStatusProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  // dashboard配下の実コンポーネントがhookを参照しても、通常運用時と同じ
  // maintenance無効状態で描画できるProvider契約をmock側にも揃える。
  useMaintenanceStatus: () => ({ mode: 'off' }),
}))

vi.mock('@/components/ChatDeliveryWarning', () => ({
  default: ({ needsAttention }: { needsAttention: boolean }) => (
    <div
      data-testid="dashboard-chat-delivery-probe"
      data-needs-attention={String(needsAttention)}
    />
  ),
}))

vi.mock('@/components/SettingsLayout', () => ({
  default: ({
    chatAnnouncement,
  }: {
    chatAnnouncement: { enabled: boolean; needsAttention: boolean }
  }) => (
    <div
      data-testid="settings-chat-delivery-probe"
      data-enabled={String(chatAnnouncement.enabled)}
      data-needs-attention={String(chatAnnouncement.needsAttention)}
    />
  ),
}))

const TWITCH_USER_ID = 'twitch-user-1'

// `enabled=true && canSendChat=false` からclient/server中間層が警告を再計算すると
// trueになる一方、server helperの確定値はfalse、という意図的なsentinel。
// DB取得失敗時の「送信可否は不明」を「送信不能」に戻す回帰を確実に検出する。
const UNKNOWN_DELIVERY_SENTINEL = {
  chatAnnouncementEnabled: true,
  hasStoredScope: false,
  hasActiveBot: false,
  canSendChat: false,
  needsAttention: false,
}

const STREAMER_DATA_SENTINEL = {
  streamer: {
    id: 'streamer-1',
    channel_point_reward_id: null,
    channel_point_reward_name: null,
    channel_point_collection_name: null,
    gacha_sound_url: null,
    gacha_sound_enabled: false,
    gacha_sound_rules: null,
    chat_announcement_enabled: true,
    chat_announcement_template: null,
    chat_announcement_multi_template: null,
    chat_announcement_multi_show_cards: true,
    show_unowned_cards: false,
    show_unowned_card_details: false,
  },
  cards: [],
}

describe('chat delivery server wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ twitchUserId: TWITCH_USER_ID })
    mocks.canUseStreamerFeatures.mockReturnValue(true)
    mocks.getUnreadAnnouncements.mockResolvedValue([])
    mocks.getUserPlanSnapshot.mockResolvedValue('basic')
    mocks.getUserPlan.mockResolvedValue('basic')
    mocks.getChatDeliveryCapability.mockResolvedValue(UNKNOWN_DELIVERY_SENTINEL)
    mocks.getStreamerData.mockResolvedValue(STREAMER_DATA_SENTINEL)
    mocks.getCustomBotAccountDisplayForStreamer.mockResolvedValue(null)
    mocks.shouldShowVoteCampaign.mockResolvedValue(false)
    // fixture不足で認証分岐へ入った場合に、redirectのno-opでテストが偶然通らないよう
    // fail-fastにする。正常系の2テストでは呼ばれないことも併せて確認する。
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`Unexpected redirect: ${path}`)
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('DashboardLayoutはhelper確定済みneedsAttention=falseを警告へそのまま渡す', async () => {
    render(await DashboardLayout({ children: <div>dashboard child</div> }))

    const probe = screen.getByTestId('dashboard-chat-delivery-probe')
    expect(probe).toHaveAttribute('data-needs-attention', 'false')
    expect(mocks.getChatDeliveryCapability).toHaveBeenCalledWith(TWITCH_USER_ID)
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  it('SettingsPageはenabled=trueでもhelper確定済みneedsAttention=falseを再計算せず渡す', async () => {
    render(await SettingsPage({ searchParams: Promise.resolve({}) }))

    const probe = screen.getByTestId('settings-chat-delivery-probe')
    expect(probe).toHaveAttribute('data-enabled', 'true')
    expect(probe).toHaveAttribute('data-needs-attention', 'false')
    expect(mocks.getChatDeliveryCapability).toHaveBeenCalledWith(TWITCH_USER_ID)
    expect(mocks.redirect).not.toHaveBeenCalled()
  })
})
