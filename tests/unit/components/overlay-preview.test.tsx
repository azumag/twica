import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import OverlayPreview from '@/components/OverlayPreview'
import type { Card } from '@/types/database'

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
      effectStyle: 'エフェクト種類',
      effectStyleDescription: '説明',
      effectStyles: {
        sparkle: 'キラキラ',
        confetti: '紙吹雪',
        hearts: 'ハート',
      },
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

// Issue #532 のテスト用カードフィクスチャ。tests/unit/components/sorted-card-grid.test.tsx の
// baseCard パターンを踏襲し、Card型の必須フィールドを一箇所にまとめる。
const baseCard = (overrides: Partial<Card>): Card => ({
  id: 'card-1',
  streamer_id: 'streamer-1',
  name: 'カードA',
  description: null,
  image_url: null,
  rarity: 'common',
  card_number: null,
  max_issuance_count: null,
  collection_name: null,
  drop_rate: 25,
  intra_rarity_weight: 1,
  is_active: true,
  hp: 10,
  atk: 5,
  def: 5,
  spd: 5,
  skill_type: 'attack',
  skill_name: 'たいあたり',
  skill_power: 10,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
  ...overrides,
})

function createLocalStorageMock() {
  const store = new Map<string, string>()

  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    clear: vi.fn(() => {
      store.clear()
    }),
  }
}

describe('OverlayPreview', () => {
  beforeEach(() => {
    const localStorageMock = createLocalStorageMock()
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    })
    vi.stubGlobal('localStorage', localStorageMock)
  })

  afterEach(() => {
    // vi.stubGlobal で書き換えた window.localStorage を必ずリセットし、
    // 同一プロセス内の他テストファイルへ漏出しないようにする
    vi.unstubAllGlobals()
    // 一部テストで vi.useFakeTimers() を使うため、他テストへ影響しないよう必ず実タイマーへ戻す
    vi.useRealTimers()
  })

  it('localStorage に保存されたオーバーレイ設定を復元する', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      imageOnly: true,
      autoPortrait: false,
      effects: false,
      effectStyle: 'hearts',
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
        effectStyle: 'sparkle',
        displayDuration: 6,
        portraitShowName: false,
        portraitShowRarity: true,
        portraitShowDescription: false,
        portraitShowUsername: false,
      })
    })
  })

  it('effects=true 時に保存された effectStyle を URL の effect= に復元する', async () => {
    // Regression: 既存の「設定復元」テストでは effects: false のため URL から effect=
    // が省略され、effectStyle の永続化往復が検証されていなかった。
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      imageOnly: false,
      autoPortrait: true,
      effects: true,
      effectStyle: 'hearts',
      smallMode: true,
      displayDuration: 6,
      portraitShowName: false,
      portraitShowRarity: true,
      portraitShowDescription: false,
      portraitShowUsername: false,
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
        screen.getByDisplayValue('https://example.com/overlay/streamer-1?effect=hearts')
      ).toBeInTheDocument()
    })
  })

  it('未知の effectStyle が永続化されている場合は sparkle に正規化する', async () => {
    // 任意ユーザー編集 / 古いバージョンの値が紛れた場合のフェイルセーフ。
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      imageOnly: false,
      autoPortrait: true,
      effects: true,
      effectStyle: 'unknown-value',
      smallMode: true,
      displayDuration: 6,
      portraitShowName: false,
      portraitShowRarity: true,
      portraitShowDescription: false,
      portraitShowUsername: false,
    }))

    renderWithIntl(
      <OverlayPreview
        streamerId="streamer-1"
        baseUrl="https://example.com"
        showPreview={false}
      />
    )

    await waitFor(() => {
      // sparkle はデフォルトのため URL に effect= は付かない（既存の URL 構築仕様）
      expect(
        screen.getByDisplayValue('https://example.com/overlay/streamer-1')
      ).toBeInTheDocument()
    })
  })

  it('エフェクト種類を選択すると overlay URL と localStorage に反映する', async () => {
    renderWithIntl(
      <OverlayPreview
        streamerId="streamer-1"
        baseUrl="https://example.com"
        showPreview={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'オーバーレイカスタマイズ' }))
    fireEvent.change(screen.getByLabelText('エフェクト種類'), { target: { value: 'confetti' } })

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://example.com/overlay/streamer-1?effect=confetti')).toBeInTheDocument()
    })

    await waitFor(() => {
      const savedOptions = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      expect(savedOptions).toMatchObject({
        effectStyle: 'confetti',
      })
    })
  })

  // Issue #532: オプション変更はiframeのURLには正しく反映されるが、カード非表示中は
  // 見た目が変わらずユーザーが変化に気づけない。デモ実行直後のオプション変更では
  // 自動的にプレビューDEMOを再実行し、変更を視覚的に確認できるようにする。
  describe('Issue #532: デモ実行後のオプション変更で自動再デモ', () => {
    it('プレビューDEMO実行後にオプションを変更すると、デバウンス後に自動的にプレビューDEMOを再実行する', async () => {
      vi.useFakeTimers()

      renderWithIntl(
        <OverlayPreview streamerId="streamer-1" baseUrl="https://example.com" />
      )

      const iframe = screen.getByTitle('Overlay Preview') as HTMLIFrameElement

      // まず手動でプレビューDEMOを実行する
      fireEvent.click(screen.getByRole('button', { name: 'プレビューDEMO' }))
      expect(iframe.src).toContain('demo=true')

      // オプションを変更する（imageOnlyをON）
      // iframeのsrcはReactが制御するprop（overlayUrlWithParams）にも束縛されているため、
      // オプション変更直後は通常の再レンダリングで一旦demoパラメータなしのURLに戻る
      // （triggerDemoによるsrcへの命令的な上書きがReactの再レンダリングで上書き返されるため）。
      fireEvent.click(screen.getByRole('button', { name: 'オーバーレイカスタマイズ' }))
      fireEvent.click(screen.getByText('正方形でも画像のみ表示'))

      // デバウンス時間が経過するまでは自動再デモ（demo=trueの付与）はまだ起きない
      expect(iframe.src).toContain('imageOnly=true')
      expect(iframe.src).not.toContain('demo=true')

      // デバウンス（800ms）経過後、自動的にプレビューDEMOが再実行され、
      // 変更後のオプション（imageOnly=true）が反映されたURLになる
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800)
      })

      expect(iframe.src).toContain('imageOnly=true')
      expect(iframe.src).toContain('demo=true')
    })

    it('プレビューDEMOを一度も実行していない場合はオプションを変更しても自動的に再デモしない', async () => {
      vi.useFakeTimers()

      renderWithIntl(
        <OverlayPreview streamerId="streamer-1" baseUrl="https://example.com" />
      )

      const iframe = screen.getByTitle('Overlay Preview') as HTMLIFrameElement

      // プレビューDEMOは実行せず、オプションのみ変更する
      fireEvent.click(screen.getByRole('button', { name: 'オーバーレイカスタマイズ' }))
      fireEvent.click(screen.getByText('正方形でも画像のみ表示'))

      // デバウンス時間を十分超えて待つ
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      // iframeのsrcはoptions変更を通常通り反映するが、demo=trueは付与されない
      // （自動デモが誤って発火していないことの確認）
      expect(iframe.src).toContain('imageOnly=true')
      expect(iframe.src).not.toContain('demo=true')
    })

    it('デモ実行から30秒より後のオプション変更では自動的に再デモしない', async () => {
      vi.useFakeTimers()

      renderWithIntl(
        <OverlayPreview streamerId="streamer-1" baseUrl="https://example.com" />
      )

      const iframe = screen.getByTitle('Overlay Preview') as HTMLIFrameElement

      fireEvent.click(screen.getByRole('button', { name: 'プレビューDEMO' }))
      expect(iframe.src).toContain('demo=true')

      // 直近デモから30秒(RECENT_DEMO_WINDOW_MS)を超えて時間が経過
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_001)
      })
      const srcBeforeOptionChange = iframe.src

      fireEvent.click(screen.getByRole('button', { name: 'オーバーレイカスタマイズ' }))
      fireEvent.click(screen.getByText('正方形でも画像のみ表示'))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })

      // 30秒ウィンドウを過ぎているため、iframeのsrcはデモ再実行によっては変わらない
      // （通常のoptions反映によるURL更新は起きるため、demo=trueが付与されないことを確認する）
      expect(iframe.src).not.toBe(srcBeforeOptionChange)
      expect(iframe.src).toContain('imageOnly=true')
      expect(iframe.src).not.toContain('demo=true')
    })
  })

  // Issue #532: effectStyle（confetti/hearts等）はlegendaryカードにのみ表示されるため、
  // ランダムデモがlegendary以外を引くと変更してもエフェクトが確認できない。
  // 効果種類の変更時にlegendaryカードがあれば自動的にプレビュー用カードへ寄せる。
  describe('Issue #532: エフェクト種類変更時のlegendaryカード自動選択', () => {
    it('legendaryカードが存在する場合、エフェクト種類を変更するとそのカードが自動選択される', async () => {
      const cards: Card[] = [
        baseCard({ id: 'common-1', name: 'コモンカード', rarity: 'common' }),
        baseCard({ id: 'legendary-1', name: 'レジェンダリーカード', rarity: 'legendary' }),
      ]

      renderWithIntl(
        <OverlayPreview streamerId="streamer-1" baseUrl="https://example.com" cards={cards} />
      )

      // 変更前はデフォルトの「ランダム」が選択されている
      expect(screen.getByDisplayValue('ランダム')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'オーバーレイカスタマイズ' }))
      fireEvent.change(screen.getByLabelText('エフェクト種類'), { target: { value: 'confetti' } })

      await waitFor(() => {
        expect(screen.getByDisplayValue('レジェンダリーカード (legendary)')).toBeInTheDocument()
      })
    })

    it('legendaryカードが存在しない場合、エフェクト種類を変更してもカード選択は変わらない', async () => {
      const cards: Card[] = [
        baseCard({ id: 'common-1', name: 'コモンカード', rarity: 'common' }),
        baseCard({ id: 'rare-1', name: 'レアカード', rarity: 'rare' }),
      ]

      renderWithIntl(
        <OverlayPreview streamerId="streamer-1" baseUrl="https://example.com" cards={cards} />
      )

      fireEvent.click(screen.getByRole('button', { name: 'オーバーレイカスタマイズ' }))
      fireEvent.change(screen.getByLabelText('エフェクト種類'), { target: { value: 'confetti' } })

      await waitFor(() => {
        expect(screen.getByDisplayValue('https://example.com/overlay/streamer-1?effect=confetti')).toBeInTheDocument()
      })

      // legendaryカードが存在しないため、カード選択はデフォルトの「ランダム」のまま
      expect(screen.getByDisplayValue('ランダム')).toBeInTheDocument()
    })
  })
})
