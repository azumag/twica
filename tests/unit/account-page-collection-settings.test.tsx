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
// #715: カードトレード設定は CARD_TRADE_UI_VISIBLE で入口ごと隠す（main #1803 の取り込み）。
// 既存の受け渡し検証は「表示中」の前提で行い、非表示時は別テストで固定するため、
// モジュール定数を hoisted な可変オブジェクト経由の getter に差し替える。
const flags = vi.hoisted(() => ({ tradeUiVisible: true }))
vi.mock('@/lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/constants')>()
  return {
    ...actual,
    get CARD_TRADE_UI_VISIBLE() {
      return flags.tradeUiVisible
    },
  }
})
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
vi.mock('@/components/AlbumDisplaySettings', () => ({
  default: (props: {
    streamerId: string
    packNames: string[]
    defaultPackName: string | null
    currentAlbumGridSizes: Record<string, number>
    currentAlbumDefaultView: string
  }) => (
    <div
      data-testid="album-probe"
      data-streamer-id={props.streamerId}
      data-packs={props.packNames.join(',')}
      data-default-pack={String(props.defaultPackName)}
      data-grid-sizes={JSON.stringify(props.currentAlbumGridSizes)}
      data-default-view={props.currentAlbumDefaultView}
    />
  ),
}))
// Issue #1782: 被りカードの表示段階設定も同じ「構造だけを検証する」方針に合わせて
// probe に差し替える。モックしないと実コンポーネントが useTranslations を呼び、
// NextIntlClientProvider が無いこのテストではレンダリングに失敗する。
vi.mock('@/components/DuplicateDisplayTierSettings', () => ({
  default: (props: {
    streamerId: string
    rarities: string[]
    currentDuplicateDisplayTiers: Record<string, number[]>
  }) => (
    <div
      data-testid="duplicate-tier-probe"
      data-streamer-id={props.streamerId}
      data-rarities={props.rarities.join(',')}
      data-tiers={JSON.stringify(props.currentDuplicateDisplayTiers)}
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
  packNames: ['weapons', 'armors'],
  defaultPackName: '基本パック',
  albumGridSizes: { __all__: 6, weapons: 9 },
  albumDefaultView: 'album' as const,
  // Issue #1782: 被りカード表示段階。既定レアリティ + カスタムレアリティの行と、
  // 保存済みのしきい値。
  rarities: ['common', 'rare', 'epic', 'legendary'],
  duplicateDisplayTiers: { legendary: [2, 5] },
}

describe('AccountSettingsPage collection sharing section', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    flags.tradeUiVisible = true
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

    // #1765 フォローアップ: アルバムのパック別既定も同じ初期値を受け取る
    const album = screen.getByTestId('album-probe')
    expect(album).toHaveAttribute('data-streamer-id', 'streamer-1')
    expect(album).toHaveAttribute('data-packs', 'weapons,armors')
    expect(album).toHaveAttribute('data-default-pack', '基本パック')
    expect(album).toHaveAttribute('data-grid-sizes', JSON.stringify({ __all__: 6, weapons: 9 }))
    expect(album).toHaveAttribute('data-default-view', 'album')

    // Issue #1782: 被りカードの表示段階設定も同じ初期値をそのまま受け取る
    const duplicateTiers = screen.getByTestId('duplicate-tier-probe')
    expect(duplicateTiers).toHaveAttribute('data-streamer-id', 'streamer-1')
    expect(duplicateTiers).toHaveAttribute('data-rarities', 'common,rare,epic,legendary')
    expect(duplicateTiers).toHaveAttribute(
      'data-tiers',
      JSON.stringify({ legendary: [2, 5] })
    )
  })

  it('canUseStreamerFeatures が false なら出さず、DBにも問い合わせない', async () => {
    mocks.canUseStreamerFeatures.mockReturnValue(false)

    render(await AccountSettingsPage())

    expect(screen.queryByTestId('collection-sharing-section')).toBeNull()
    expect(screen.queryByTestId('visibility-probe')).toBeNull()
    expect(screen.queryByTestId('trade-probe')).toBeNull()
    expect(screen.queryByTestId('album-probe')).toBeNull()
    expect(screen.queryByTestId('duplicate-tier-probe')).toBeNull()
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

  it('CARD_TRADE_UI_VISIBLE=false ならトレード設定だけを出さず、他の公開設定は残す (#715)', async () => {
    flags.tradeUiVisible = false

    render(await AccountSettingsPage())

    expect(screen.queryByTestId('trade-probe')).toBeNull()
    // 入口を消しただけでセクション自体は壊れていないことを同時に確認する
    expect(screen.getByTestId('collection-sharing-section')).toBeInTheDocument()
    expect(screen.getByTestId('visibility-probe')).toBeInTheDocument()
    expect(screen.getByTestId('album-probe')).toBeInTheDocument()
  })
})
