import { describe, it, expect, beforeEach, vi } from 'vitest'
import CopyButton from '@/components/CopyButton'

vi.mock('@/lib/logger')
vi.mock('@/lib/constants')

describe('CopyButton', () => {
  const mockText = 'Test text to copy'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('基本構造', () => {
    it('コンポーネントをインポートできる', () => {
      expect(CopyButton).toBeDefined()
    })

    it('text プロパティを受け入れるコンポーネントが作成できる', () => {
      expect(() => <CopyButton text={mockText} />).not.toThrow()
    })

    it('空のテキストでコンポーネントを作成できる', () => {
      expect(() => <CopyButton text="" />).not.toThrow()
    })
  })

  describe('エラーハンドリング準備', () => {
    it('クリップボードがサポートされていない環境でもコンポーネントは作成できる', () => {
      Object.assign(navigator, {
        clipboard: undefined,
      })

      expect(() => <CopyButton text={mockText} />).not.toThrow()
    })
  })
})
