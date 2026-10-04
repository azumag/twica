import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SettingsPage from '@/app/dashboard/settings/page'

/**
 * コレクション公開設定(show_unowned_*)とカードトレード設定を /dashboard/account へ
 * 移したため、これらのフラグは「詳細設定を使用中」判定(初期モード)に含めない。
 * 移動先の無い設定のために Advanced が初期表示される不整合の回帰テスト。
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
  getStreamerData: vi.fn(),
  getUserPlan: vi.fn(),
  getChatDeliveryCapability: vi.fn(),
  getCustomBotAccountDisplayForStreamer: vi.fn(),
  shouldShowVoteCampaign: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('@/lib/session', () => ({
  getSession: mocks.getSession,
  canUseStreamerFeatures: mocks.canUseStreamerFeatures,
}))
vi.mock('@/lib/plan', () => ({ getUserPlan: mocks.getUserPlan }))
vi.mock('@/lib/dashboard-data', () => ({ getStreamerData: mocks.getStreamerData }))
vi.mock('@/lib/twitch/token-manager', () => ({
  getCustomBotAccountDisplayForStreamer: mocks.getCustomBotAccountDisplayForStreamer,
}))
vi.mock('@/lib/twitch/chat-delivery-capability', () => ({
  getChatDeliveryCapability: mocks.getChatDeliveryCapability,
}))
vi.mock('@/lib/storage-db', () => ({ shouldShowVoteCampaign: mocks.shouldShowVoteCampaign }))
vi.mock('@/lib/overlay-realtime/presence-token', () => ({
  createOverlayPresenceToken: vi.fn().mockResolvedValue('presence-token'),
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
vi.mock('@/components/SettingsLayout', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="settings-layout-probe"
      data-initial-mode-hint={String(props.initialModeHint)}
      data-prop-keys={Object.keys(props).sort().join(',')}
    />
  ),
}))

function makeStreamer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'streamer-1',
    channel_point_reward_id: null,
    channel_point_reward_name: null,
    channel_point_collection_name: null,
    gacha_sound_url: null,
    gacha_sound_enabled: false,
    gacha_sound_rules: null,
    chat_announcement_enabled: false,
    chat_announcement_template: null,
    chat_announcement_multi_template: null,
    chat_announcement_multi_show_cards: true,
    show_unowned_cards: false,
    show_unowned_card_details: false,
    publish_live_status: false,
    publish_stats: false,
    trade_enabled: false,
    cross_channel_trade_enabled: false,
    ...overrides,
  }
}

async function renderPage(streamerOverrides: Record<string, unknown>) {
  mocks.getStreamerData.mockResolvedValue({ streamer: makeStreamer(streamerOverrides), cards: [] })
  render(await SettingsPage({ searchParams: Promise.resolve({}) }))
  return screen.getByTestId('settings-layout-probe')
}

describe('SettingsPage initial mode detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ twitchUserId: 'twitch-user-1' })
    mocks.canUseStreamerFeatures.mockReturnValue(true)
    mocks.getUserPlan.mockResolvedValue('basic')
    mocks.getChatDeliveryCapability.mockResolvedValue({ needsAttention: false })
    mocks.getCustomBotAccountDisplayForStreamer.mockResolvedValue(null)
    mocks.shouldShowVoteCampaign.mockResolvedValue(false)
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`Unexpected redirect: ${path}`)
    })
  })

  afterEach(() => {
    cleanup()
  })

  it.each([
    ['show_unowned_cards'],
    ['show_unowned_card_details'],
    ['trade_enabled'],
    ['cross_channel_trade_enabled'],
  ])('%s だけが true でも simple のまま（アカウント画面へ移動済みの設定）', async (flag) => {
    const probe = await renderPage({ [flag]: true })
    expect(probe).toHaveAttribute('data-initial-mode-hint', 'simple')
  })

  it('4フラグを全て true にしても simple のまま', async () => {
    const probe = await renderPage({
      show_unowned_cards: true,
      show_unowned_card_details: true,
      trade_enabled: true,
      cross_channel_trade_enabled: true,
    })
    expect(probe).toHaveAttribute('data-initial-mode-hint', 'simple')
  })

  it.each([
    ['gacha_sound_enabled'],
    ['chat_announcement_enabled'],
    ['publish_live_status'],
    ['publish_stats'],
  ])('settings に残る %s が true なら advanced（既存挙動の維持）', async (flag) => {
    const probe = await renderPage({ [flag]: true })
    expect(probe).toHaveAttribute('data-initial-mode-hint', 'advanced')
  })

  it('SettingsLayout へ visibility / trade props を渡さない', async () => {
    const probe = await renderPage({})
    const keys = probe.getAttribute('data-prop-keys')?.split(',') ?? []
    expect(keys).not.toContain('visibility')
    expect(keys).not.toContain('trade')
    expect(keys).toContain('liveDirectory')
  })
})
