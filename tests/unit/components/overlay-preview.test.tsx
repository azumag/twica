import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import OverlayPreview from '@/components/OverlayPreview'

const STORAGE_KEY = 'twica:overlay-options:streamer-1'

const messages = {
  common: {
    copy: 'コピー',
    copied: 'コピーしました',
  },
  dashboard: {
    obsOverlayUrl: 'OBSオーバーレイURL',
    obsOverlayDescription: 'OBSに設定するURLです',
  },
  overlaySettings: {
    title: 'オーバーレイカスタマイズ',
    description: 'オーバーレイの表示オプションを設定できます。変更はOBSブラウザソースURLに反映されます。',
    autoSaved: '変更内容はこのブラウザに自動保存されます。',
    preview: 'プレビュー',
    previewDemo: 'プレビューDEMO',
    obsDemo: 'OBS DEMO',
    demoHelpTitle: 'デモの種類',
    close: '閉じる',
    demoNote: 'デモノート',
    urlUpdated: 'オーバーレイURLが更新されました',
    collectionUrl: 'コレクションページURL',
    collectionUrlDescription: 'コレクションページです。',
    options: {
      imageOnly: '正方形でも画像のみ表示',
      imageOnlyDescription: '説明',
      autoPortrait: '縦長画像を自動検出',
      autoPortraitDescription: '説明',
      effects: 'エフェクト表示',
      effectsDescription: '説明',
      smallMode: '小さい画像モード',
      smallModeDescription: '説明',
      displayDuration: 'カードの表示時間',
      displayDurationDescription: '説明',
      seconds: '秒',
      portraitInfoSection: '縦長画像の付帯情報（画像の下に表示）',
      portraitShowName: 'カード名を表示',
      portraitShowNameDescription: '説明',
      portraitShowRarity: 'レアリティを表示',
      portraitShowRarityDescription: '説明',
      portraitShowDescription: '説明を表示',
      portraitShowDescriptionDescription: '説明',
      portraitShowUsername: 'ユーザー名を表示',
      portraitShowUsernameDescription: '説明',
    },
  },
}

const renderWithIntl = (component: React.ReactElement) => {
  return render(
    <NextIntlClientProvider locale="ja" messages={messages}>
      {component}
    </NextIntlClientProvider>
  )
}

describe('OverlayPreview', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('localStorage に保存されたオーバーレイ設定を復元する', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      imageOnly: true,
      autoPortrait: false,
      effects: false,
      smallMode: false,
      displayDuration: 10,
      portraitShowName: true,
      portraitShowRarity: false,
      portraitShowDescription: true,
      portraitShowUsername: true,
    }))

    renderWithIntl(
      <OverlayPreview
        streamerId="streamer-1"
        baseUrl="https://example.com"
        showPreview={false}
      />
    )

    await waitFor(() => {
      expect(
        screen.getByDisplayValue(
          'https://example.com/overlay/streamer-1?imageOnly=true&autoPortrait=false&effects=false&smallMode=false&duration=10&pName=true&pRarity=false&pDesc=true&pUser=true'
        )
      ).toBeInTheDocument()
    })
  })

  it('オプション変更を localStorage に自動保存する', async () => {
    renderWithIntl(
      <OverlayPreview
        streamerId="streamer-1"
        baseUrl="https://example.com"
        showPreview={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'オーバーレイカスタマイズ' }))
    fireEvent.click(screen.getByText('正方形でも画像のみ表示'))

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://example.com/overlay/streamer-1?imageOnly=true')).toBeInTheDocument()
    })

    await waitFor(() => {
      const savedOptions = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      expect(savedOptions).toMatchObject({
        imageOnly: true,
        autoPortrait: true,
        effects: true,
        smallMode: true,
        displayDuration: 6,
        portraitShowName: false,
        portraitShowRarity: true,
        portraitShowDescription: false,
        portraitShowUsername: false,
      })
    })
  })
})
