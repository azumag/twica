import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import {
  AdvancedSettings,
  SettingsViewModeProvider,
  SettingsViewToggle,
  __resetSettingsViewModeSubscribersForTest,
} from '@/components/SettingsViewMode'

// localStorage キー名は実装と一致させる (二重定義は避けたいが、テスト用途に限り直書き)。
const STORAGE_KEY = 'twica.settingsViewMode'

const messages = {
  settingsPage: {
    viewMode: {
      simple: 'シンプル',
      advanced: '詳細',
      ariaLabel: '配信設定の表示モードを切り替え',
    },
  },
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
    window.localStorage.clear()
    // モジュールスコープの購読者集合がテスト間で漏れないようにリセット。
    __resetSettingsViewModeSubscribersForTest()
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
    it('Provider 外で AdvancedSettings を使うと例外', () => {
      // テスト時の console.error を抑制するため、render を try/catch で囲む。
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(() =>
        render(
          <NextIntlClientProvider locale="ja" messages={messages}>
            <AdvancedSettings>
              <p>x</p>
            </AdvancedSettings>
          </NextIntlClientProvider>
        )
      ).toThrow(/SettingsViewModeProvider/)
      spy.mockRestore()
    })
  })
})
