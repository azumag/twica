import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import {
  AdvancedSettings,
  AdvancedSettingsLayout,
  SettingsViewModeProvider,
  SettingsViewToggle,
  __resetSettingsViewModeSubscribersForTest,
} from '@/components/SettingsViewMode'

// localStorage キー名は実装と一致させる (二重定義は避けたいが、テスト用途に限り直書き)。
const STORAGE_KEY = 'twica.settingsViewMode'

const messages = {
  settingsPage: {
    advanced: {
      navAria: '詳細設定ナビゲーション',
    },
    viewMode: {
      simple: 'シンプル',
      advanced: '詳細',
      ariaLabel: '配信設定の表示モードを切り替え',
    },
  },
}

function installLocalStorageMock() {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() {
        return store.size
      },
      clear: vi.fn(() => store.clear()),
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
      removeItem: vi.fn((key: string) => {
        store.delete(key)
      }),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, String(value))
      }),
    },
  })
}

function renderWithProvider(
  ui: React.ReactNode,
  options: { initialModeHint?: 'simple' | 'advanced' } = {}
) {
  return render(
    <NextIntlClientProvider locale="ja" messages={messages}>
      <SettingsViewModeProvider initialModeHint={options.initialModeHint}>
        {ui}
      </SettingsViewModeProvider>
    </NextIntlClientProvider>
  )
}

describe('SettingsViewMode', () => {
  beforeEach(() => {
    installLocalStorageMock()
    window.localStorage.clear()
    // モジュールスコープの購読者集合がテスト間で漏れないようにリセット。
    __resetSettingsViewModeSubscribersForTest()
  })

  afterEach(() => {
    // Vitestの実行順・bundle分割に依存せずDOMを破棄する。前テストのsidebarが残ると
    // getByRole/getByTestIdが複数一致し、実装回帰ではない失敗を生むため明示する。
    cleanup()
    vi.restoreAllMocks()
  })

  describe('SettingsViewToggle', () => {
    it('初期状態ではシンプルが選択されている (aria-pressed)', () => {
      renderWithProvider(<SettingsViewToggle />)
      const simpleBtn = screen.getByRole('button', { name: 'シンプル' })
      const advancedBtn = screen.getByRole('button', { name: '詳細' })
      expect(simpleBtn).toHaveAttribute('aria-pressed', 'true')
      expect(advancedBtn).toHaveAttribute('aria-pressed', 'false')
    })

    it('詳細をクリックすると aria-pressed が切り替わり localStorage に保存される', () => {
      renderWithProvider(<SettingsViewToggle />)
      const advancedBtn = screen.getByRole('button', { name: '詳細' })

      fireEvent.click(advancedBtn)

      expect(advancedBtn).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByRole('button', { name: 'シンプル' })).toHaveAttribute(
        'aria-pressed',
        'false'
      )
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('advanced')
    })

    it('localStorage に保存済みの値が mount 後に反映される', () => {
      window.localStorage.setItem(STORAGE_KEY, 'advanced')
      renderWithProvider(<SettingsViewToggle />)
      // Provider が useEffect で同期する。act でフラッシュ。
      act(() => {})
      expect(
        screen.getByRole('button', { name: '詳細' })
      ).toHaveAttribute('aria-pressed', 'true')
    })

    it('不正な値が保存されていてもデフォルト (シンプル) のまま', () => {
      window.localStorage.setItem(STORAGE_KEY, 'bogus')
      renderWithProvider(<SettingsViewToggle />)
      act(() => {})
      expect(
        screen.getByRole('button', { name: 'シンプル' })
      ).toHaveAttribute('aria-pressed', 'true')
    })

    it('localStorage 未保存 + initialModeHint=advanced で詳細モードになる', () => {
      renderWithProvider(<SettingsViewToggle />, { initialModeHint: 'advanced' })
      act(() => {})
      expect(
        screen.getByRole('button', { name: '詳細' })
      ).toHaveAttribute('aria-pressed', 'true')
    })

    it('localStorage に保存値があれば initialModeHint より優先される', () => {
      window.localStorage.setItem(STORAGE_KEY, 'simple')
      renderWithProvider(<SettingsViewToggle />, { initialModeHint: 'advanced' })
      act(() => {})
      expect(
        screen.getByRole('button', { name: 'シンプル' })
      ).toHaveAttribute('aria-pressed', 'true')
    })

    it('明示URL導線のrequestedModeは保存済みsimpleより優先して詳細を開く', () => {
      window.localStorage.setItem(STORAGE_KEY, 'simple')
      render(
        <NextIntlClientProvider locale="ja" messages={messages}>
          <SettingsViewModeProvider initialModeHint="simple" requestedMode="advanced">
            <SettingsViewToggle />
          </SettingsViewModeProvider>
        </NextIntlClientProvider>
      )
      act(() => {})
      expect(screen.getByRole('button', { name: '詳細' })).toHaveAttribute('aria-pressed', 'true')
    })

    it('localStorage への保存に失敗しても同一タブ内では表示モードを切り替えられる', () => {
      vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
        throw new Error('storage disabled')
      })
      renderWithProvider(
        <>
          <SettingsViewToggle />
          <AdvancedSettings>
            <p>advanced-content</p>
          </AdvancedSettings>
        </>
      )

      fireEvent.click(screen.getByRole('button', { name: '詳細' }))

      expect(screen.getByRole('button', { name: '詳細' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      expect(screen.getByTestId('advanced-settings')).not.toHaveAttribute('hidden')
    })

    it('group ロールに aria-label が付与されている', () => {
      renderWithProvider(<SettingsViewToggle />)
      const group = screen.getByRole('group', {
        name: '配信設定の表示モードを切り替え',
      })
      expect(group).toBeInTheDocument()
    })
  })

  describe('AdvancedSettings', () => {
    it('シンプルモードでは hidden 属性付きで描画される', () => {
      renderWithProvider(
        <>
          <SettingsViewToggle />
          <AdvancedSettings>
            <p>advanced-content</p>
          </AdvancedSettings>
        </>
      )
      const wrapper = screen.getByTestId('advanced-settings')
      expect(wrapper).toHaveAttribute('hidden')
      expect(wrapper).toHaveAttribute('aria-hidden', 'true')
      // DOM 上には存在する (state 保持のため)
      expect(wrapper).toContainHTML('advanced-content')
    })

    it('詳細モードに切替えると hidden と aria-hidden の両方が外れる', () => {
      renderWithProvider(
        <>
          <SettingsViewToggle />
          <AdvancedSettings>
            <p>advanced-content</p>
          </AdvancedSettings>
        </>
      )
      fireEvent.click(screen.getByRole('button', { name: '詳細' }))
      const wrapper = screen.getByTestId('advanced-settings')
      expect(wrapper).not.toHaveAttribute('hidden')
      // aria-hidden は false 明示せず属性自体を消す (WAI-ARIA 仕様準拠)
      expect(wrapper).not.toHaveAttribute('aria-hidden')
    })
  })

  describe('useSettingsViewMode (Provider 未使用時)', () => {
    it('Provider 外でも AdvancedSettings は children を表示する (= advanced フォールバック)', () => {
      // Provider 未使用時は安全側に倒し「advanced (= 全機能表示)」をフォールバックとして返す。
      // これにより個別の設定コンポーネントを単独 (テスト/Storybook/エラーフォールバック等) で
      // レンダリングしてもクラッシュしないことを保証する。
      render(
        <NextIntlClientProvider locale="ja" messages={messages}>
          <AdvancedSettings>
            <p>advanced-fallback-content</p>
          </AdvancedSettings>
        </NextIntlClientProvider>
      )
      // children が表示されていること
      expect(screen.getByText('advanced-fallback-content')).toBeInTheDocument()
      // hidden / aria-hidden が付与されていないこと (= advanced モードで可視)
      const wrapper = screen.getByTestId('advanced-settings')
      expect(wrapper).not.toHaveAttribute('hidden')
      expect(wrapper).not.toHaveAttribute('aria-hidden')
    })
  })

  describe('AdvancedSettingsLayout', () => {
    it('初期表示ではactive sectionだけをmountし、選択後は訪問済みsectionを保持する', () => {
      renderWithProvider(
        <AdvancedSettingsLayout
          sections={[
            { id: 'first', label: 'First', content: <div data-testid="first-panel">first</div> },
            { id: 'second', label: 'Second', content: <div data-testid="second-panel">second</div> },
          ]}
        />
      )

      expect(screen.getByTestId('first-panel')).toBeInTheDocument()
      expect(screen.queryByTestId('second-panel')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: /Second/ }))

      expect(screen.getByTestId('first-panel').parentElement).toHaveAttribute('hidden')
      expect(screen.getByTestId('second-panel')).toBeInTheDocument()
    })

    it('allowlist済みinitialSectionIdを初期選択し、attentionを色と可視テキストで示す', () => {
      renderWithProvider(
        <AdvancedSettingsLayout
          initialSectionId="announcement"
          sections={[
            { id: 'overlay', label: 'Overlay', content: <div>overlay panel</div> },
            {
              id: 'announcement',
              label: 'チャット通知',
              status: 'attention',
              attentionLabel: '要対応',
              content: <div>chat panel</div>,
            },
          ]}
        />
      )

      expect(screen.getByText('chat panel')).toBeInTheDocument()
      expect(screen.queryByText('overlay panel')).toBeNull()
      expect(screen.getByText('要対応')).toBeVisible()
      expect(screen.getByRole('button', { name: /チャット通知.*要対応/ })).toHaveAttribute(
        'aria-current',
        'true',
      )
    })

    it('未知のinitialSectionIdは先頭sectionへfallbackする', () => {
      renderWithProvider(
        <AdvancedSettingsLayout
          initialSectionId="not-allowed"
          sections={[
            { id: 'overlay', label: 'Overlay', content: <div>overlay panel</div> },
            { id: 'announcement', label: 'Chat', content: <div>chat panel</div> },
          ]}
        />
      )
      expect(screen.getByText('overlay panel')).toBeInTheDocument()
      expect(screen.queryByText('chat panel')).toBeNull()
    })
  })
})
