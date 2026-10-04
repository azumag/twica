import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import AccountSettingsPage from '@/app/dashboard/account/page'

/**
 * /dashboard/account のコレクション公開設定・カードトレード設定セクション。
 * 表示条件(canUseStreamerFeatures && streamers行あり)と初期値の受け渡しを検証する。
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  canUseStreamerFeatures: vi.fn(),
  getUserPlan: vi.fn(),
  getTwitchSubRow: vi.fn(),
  getStreamerCollectionSettings: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('@/lib/session', () => ({
  getSession: mocks.getSession,
  canUseStreamerFeatures: mocks.canUseStreamerFeatures,
}))
vi.mock('@/lib/plan', () => ({ getUserPlan: mocks.getUserPlan }))
vi.mock('@/lib/user-data', () => ({ getTwitchSubRow: mocks.getTwitchSubRow }))
vi.mock('@/lib/dashboard-data', () => ({
  getStreamerCollectionSettings: mocks.getStreamerCollectionSettings,
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }))
// キー文字列をそのまま返し、i18nメッセージ内容ではなく構造だけを検証する。
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}))

vi.mock('@/components/LanguageSwitcher', () => ({ LanguageSwitcherSettings: () => null }))
vi.mock('@/components/SupportPlanSection', () => ({ default: () => null }))
vi.mock('@/components/TwitchSubCheckSection', () => ({ default: () => null }))
vi.mock('@/components/ChannelPointsAccessSection', () => ({ default: () => null }))
vi.mock('@/components/CardVisibilitySettings', () => ({
  default: (props: {
    streamerId: string
    currentShowUnowned: boolean
    currentShowUnownedDetails: boolean
  }) => (
    <div
      data-testid="visibility-probe"
      data-streamer-id={props.streamerId}
      data-show-unowned={String(props.currentShowUnowned)}
      data-show-details={String(props.currentShowUnownedDetails)}
    />
  ),
}))
vi.mock('@/components/TradeSettings', () => ({
  default: (props: {
    streamerId: string
    currentTradeEnabled: boolean
    currentCrossChannelTradeEnabled: boolean
  }) => (
    <div
      data-testid="trade-probe"
      data-streamer-id={props.streamerId}
      data-trade={String(props.currentTradeEnabled)}
      data-cross={String(props.currentCrossChannelTradeEnabled)}
    />
  ),
}))

const SETTINGS = {
  streamerId: 'streamer-1',
  showUnownedCards: true,
  showUnownedCardDetails: false,
  tradeEnabled: true,
  crossChannelTradeEnabled: false,
}

describe('AccountSettingsPage collection sharing section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSession.mockResolvedValue({ twitchUserId: 'twitch-user-1' })
    mocks.canUseStreamerFeatures.mockReturnValue(true)
    mocks.getUserPlan.mockResolvedValue('basic')
    mocks.getTwitchSubRow.mockResolvedValue(null)
    mocks.getStreamerCollectionSettings.mockResolvedValue(SETTINGS)
    // next/navigation の redirect は実際には throw して処理を打ち切る。
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`)
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('未ログインならトップへ redirect し、設定を読まない', async () => {
    mocks.getSession.mockResolvedValue(null)

    await expect(AccountSettingsPage()).rejects.toThrow('NEXT_REDIRECT:/')
    expect(mocks.getStreamerCollectionSettings).not.toHaveBeenCalled()
  })

  it('配信者なら見出しと2つの設定を出し、初期値を既存コンポーネントへそのまま渡す', async () => {
    render(await AccountSettingsPage())

    expect(screen.getByTestId('collection-sharing-section')).toBeInTheDocument()
    expect(screen.getByText('collectionSharing.title')).toBeInTheDocument()
    expect(mocks.getStreamerCollectionSettings).toHaveBeenCalledWith('twitch-user-1')

    const visibility = screen.getByTestId('visibility-probe')
    expect(visibility).toHaveAttribute('data-streamer-id', 'streamer-1')
    expect(visibility).toHaveAttribute('data-show-unowned', 'true')
    expect(visibility).toHaveAttribute('data-show-details', 'false')

    const trade = screen.getByTestId('trade-probe')
    expect(trade).toHaveAttribute('data-streamer-id', 'streamer-1')
    expect(trade).toHaveAttribute('data-trade', 'true')
    expect(trade).toHaveAttribute('data-cross', 'false')
  })

  it('canUseStreamerFeatures が false なら出さず、DBにも問い合わせない', async () => {
    mocks.canUseStreamerFeatures.mockReturnValue(false)

    render(await AccountSettingsPage())

    expect(screen.queryByTestId('collection-sharing-section')).toBeNull()
    expect(screen.queryByTestId('visibility-probe')).toBeNull()
    expect(screen.queryByTestId('trade-probe')).toBeNull()
    expect(mocks.getStreamerCollectionSettings).not.toHaveBeenCalled()
  })

  it('streamers 行が無い(null)なら出さない。ページ自体は描画される', async () => {
    mocks.getStreamerCollectionSettings.mockResolvedValue(null)

    render(await AccountSettingsPage())

    expect(screen.queryByTestId('collection-sharing-section')).toBeNull()
    expect(screen.getByText('title')).toBeInTheDocument()
  })

  it('列欠落のデプロイ窓で trade が false に倒れた値もそのまま渡す', async () => {
    mocks.getStreamerCollectionSettings.mockResolvedValue({
      ...SETTINGS,
      tradeEnabled: false,
      crossChannelTradeEnabled: false,
    })

    render(await AccountSettingsPage())

    expect(screen.getByTestId('trade-probe')).toHaveAttribute('data-trade', 'false')
    expect(screen.getByTestId('trade-probe')).toHaveAttribute('data-cross', 'false')
  })
})
