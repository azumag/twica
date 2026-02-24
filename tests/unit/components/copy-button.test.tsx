import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import CopyButton from '@/components/CopyButton'

vi.mock('@/lib/logger')

// Mock messages for i18n testing
// i18nテスト用のモックメッセージ
const messages = {
  common: {
    copy: 'コピー',
    copied: 'コピーしました',
  },
}

// Wrapper component for providing i18n context
// i18nコンテキストを提供するラッパーコンポーネント
const renderWithIntl = (component: React.ReactElement) => {
  return render(
    <NextIntlClientProvider locale="ja" messages={messages}>
      {component}
    </NextIntlClientProvider>
  )
}

describe('CopyButton', () => {
  const mockText = 'Test text to copy'

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  describe('基本レンダリング', () => {
    it('デフォルトのコピー状態でレンダリングされる', () => {
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')
      expect(button).toBeInTheDocument()
      expect(button).toHaveTextContent('コピー')
    })

    it('「コピー」テキストが表示される', () => {
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByText('コピー')
      expect(button).toBeInTheDocument()
    })

    it('適切なCSSクラスが適用されている', () => {
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')
      expect(button).toHaveClass('rounded-lg', 'bg-purple-600', 'px-4', 'py-2', 'text-white', 'hover:bg-purple-700')
    })

    it('空のテキストでレンダリングできる', () => {
      renderWithIntl(<CopyButton text="" />)
      const button = screen.getByRole('button')
      expect(button).toBeInTheDocument()
    })

    it('長いテキストでレンダリングできる', () => {
      const longText = 'a'.repeat(1000)
      renderWithIntl(<CopyButton text={longText} />)
      const button = screen.getByRole('button')
      expect(button).toBeInTheDocument()
    })
  })

  describe('コピー機能（正常系）', () => {
    it('ボタンをクリックすると、navigator.clipboard.writeText() が呼び出される', async () => {
      const writeTextMock = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined)
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith(mockText)
      })

      writeTextMock.mockRestore()
    })

    it('コピーが成功すると、ボタンのテキストが「コピーしました」に変化', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined)
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(button).toHaveTextContent('コピーしました')
      })
    })

    it('2秒後にボタンのテキストが「コピー」に戻る', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined)
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(button).toHaveTextContent('コピーしました')
      })

      await waitFor(
        () => {
          expect(button).toHaveTextContent('コピー')
        },
        { timeout: 3000 }
      )
    })

    it('text プロパティが正しく渡される', async () => {
      const customText = 'Custom text to copy'
      const writeTextMock = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined)
      renderWithIntl(<CopyButton text={customText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith(customText)
      })

      writeTextMock.mockRestore()
    })

    it('特殊文字を含むテキストをコピーできる', async () => {
      const specialText = 'Test with émojis 🎉 and spëcial çhars!'
      const writeTextMock = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValueOnce(undefined)
      renderWithIntl(<CopyButton text={specialText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith(specialText)
      })

      writeTextMock.mockRestore()
    })

    it('複数回クリックしても正しく動作する', async () => {
      const writeTextMock = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)
      await waitFor(() => {
        expect(button).toHaveTextContent('コピーしました')
      })

      await waitFor(
        () => {
          expect(button).toHaveTextContent('コピー')
        },
        { timeout: 3000 }
      )

      fireEvent.click(button)
      await waitFor(() => {
        expect(button).toHaveTextContent('コピーしました')
      })

      expect(writeTextMock).toHaveBeenCalledTimes(2)

      writeTextMock.mockRestore()
    })
  })

  describe('エラーハンドリング', () => {
    it('クリップボードへのコピーが失敗すると、エラーログが出力される', async () => {
      const { logger } = await import('@/lib/logger')
      const errorSpy = vi.spyOn(logger, 'error')
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Clipboard error'))

      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith('Failed to copy')
      })

      errorSpy.mockRestore()
    })

    it('エラー時にボタンのテキストは「コピー」のままである', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Clipboard error'))
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)

      await waitFor(() => {
        expect(button).toHaveTextContent('コピー')
      })
    })

    it('エラー時にユーザー操作には影響がない', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Clipboard error'))
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')

      fireEvent.click(button)
      await waitFor(() => {})

      expect(button).toBeEnabled()
      expect(button).toBeInTheDocument()
    })

    it('クリップボードAPIが利用できない場合でもコンポーネントはクラッシュしない', async () => {
      Object.assign(navigator, { clipboard: undefined })
      const { logger } = await import('@/lib/logger')
      const errorSpy = vi.spyOn(logger, 'error')

      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')

      expect(() => fireEvent.click(button)).not.toThrow()

      await waitFor(() => {
        expect(button).toBeInTheDocument()
      })

      errorSpy.mockRestore()
    })
  })

  describe('アクセシビリティ', () => {
    it('button要素が正しくレンダリングされる', () => {
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')
      expect(button).toBeInTheDocument()
    })

    it('ボタンはデフォルトで有効になっている', () => {
      renderWithIntl(<CopyButton text={mockText} />)
      const button = screen.getByRole('button')
      expect(button).toBeEnabled()
    })
  })

  describe('スナップショットテスト', () => {
    it('デフォルト状態のスナップショット', () => {
      const { container } = renderWithIntl(<CopyButton text={mockText} />)
      expect(container.firstChild).toMatchSnapshot()
    })
  })
})
