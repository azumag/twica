import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import SettingsLayout, { type SettingsLayoutData } from '@/components/SettingsLayout'
import jaMessages from '../../../messages/ja.json'

// dynamic import 先の実コンポーネントは fetch 等を行うため、セクション構成の検証に
// 必要な最小限の probe に差し替える。
vi.mock('@/components/OverlayPreview', () => ({ default: () => <div data-testid="overlay-panel" /> }))
vi.mock('@/components/ChannelPointSettings', () => ({ default: () => <div /> }))
vi.mock('@/components/GachaSoundSettings', () => ({ default: () => <div /> }))
vi.mock('@/components/ChatAnnouncementSettings', () => ({ default: () => <div /> }))
vi.mock('@/components/LiveDirectorySettings', () => ({ default: () => <div /> }))
vi.mock('@/components/VoteCampaignButton', () => ({ default: () => null }))

function makeData(): SettingsLayoutData {
  return {
    streamerId: 'streamer-1',
    plan: 'basic',
    baseUrl: 'https://example.test',
    cards: [],
    showVoteCampaign: false,
    botAccount: null,
    channelPoint: { rewardId: null, rewardName: null, collectionName: null },
    gachaSound: { soundUrl: null, soundEnabled: false, soundRules: [] },
    chatAnnouncement: {
      enabled: false,
      needsAttention: false,
      template: null,
      multiTemplate: null,
      multiShowCards: true,
    },
    liveDirectory: { publishLiveStatus: false, publishStats: false },
    initialModeHint: 'advanced',
  }
}

describe('SettingsLayout advanced sections', () => {
  beforeEach(() => {
    try {
      window.localStorage.clear()
    } catch {
      // localStorage が使えない環境でも initialModeHint で advanced になる。
    }
  })

  afterEach(() => {
    cleanup()
  })

  it('コレクション公開設定とカードトレードはアカウント画面へ移動済みで、サイドバーに出さない', () => {
    render(
      <NextIntlClientProvider locale="ja" messages={jaMessages}>
        <SettingsLayout {...makeData()} />
      </NextIntlClientProvider>
    )

    // 残るべきセクションが描画されていること(空描画で偶然通らないための対照)。
    const section = jaMessages.settingsPage.advanced.section
    for (const label of [section.overlay, section.reward, section.liveDirectory, section.share]) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }

    expect(screen.queryByRole('button', { name: /公開設定/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /カードトレード/ })).toBeNull()
    // 削除済みi18nキーが復活していないこと。
    expect(section).not.toHaveProperty('visibility')
    expect(section).not.toHaveProperty('trade')
  })
})
