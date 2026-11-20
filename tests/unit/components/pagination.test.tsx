import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import Pagination from '@/components/Pagination'
import jaMessages from '../../../messages/ja.json'

// Issue #2102 の回帰: 375px 幅（clientWidth=360）でページ数が多いと、
// 「前へ＋ページ番号群＋次へ＋ページ情報」の単一行 flex が viewport を超え、
// ページ情報がはみ出してページ全体に横スクロールが発生していた。
//
// 修正はレスポンシブページネーションの標準パターン（Tailwind UI 方式）に従い、
// sm 未満では番号リストを出さず `‹ {current} / {total} ›` のコンパクト表示に
// 切り替える。ページ数がいくら増えても幅が変わらないため、はみ出しが再発しない。
// sm 以上では従来どおり番号リスト＋ページ情報を維持する。
//
// happy-dom はレイアウトを計算しないため、実際の is Overflow は計測できない。
// その代わりに「モバイル表示要素が sm:hidden」「番号リストが hidden sm:flex」
// というレスポンシブ契約（クラス）と、コンパクト表示がページ情報テキストを
// 含むことを検証する。
function renderPagination(currentPage = 5, totalPages = 20) {
  const onPageChange = vi.fn()
  const utils = render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
      />
    </NextIntlClientProvider>
  )
  return { onPageChange, ...utils }
}

describe('Pagination responsive layout (Issue #2102 regression)', () => {
  it('renders a compact "current / total" indicator that is only visible below sm', () => {
    const { container } = renderPagination(5, 20)

    const compact = container.querySelector('span[class*="sm:hidden"]')
    expect(compact).not.toBeNull()
    // コンパクト表示は「現在のページ」と「ページ情報」の両方を兼ねる
    expect(compact!.textContent).toBe('5 / 20')
    expect(compact!).toHaveAttribute('aria-current', 'page')
  })

  it('keeps the numbered page list hidden below sm and visible from sm', () => {
    const { container } = renderPagination(5, 20)

    const numbers = container.querySelector('div[class*="sm:flex"]')
    expect(numbers).not.toBeNull()
    expect(numbers!.className).toContain('hidden')
    // 現在のページがハイライト済みで残っている（aria-current）
    expect(numbers!.querySelector('[aria-current="page"]')?.textContent).toBe('5')
  })

  it('hides the trailing page info below sm so it cannot overflow', () => {
    const { container } = renderPagination(5, 20)

    const infos = Array.from(container.querySelectorAll('span')).filter(
      (el) => el.textContent === '5 / 20'
    )
    // コンパクト表示（sm:hidden）とデスクトップ表示（hidden sm:inline）の2つ
    expect(infos).toHaveLength(2)
    const desktopInfo = infos.find((el) => el.className.includes('sm:inline'))
    expect(desktopInfo).toBeDefined()
    expect(desktopInfo!.className).toContain('hidden')
  })

  it('stays bounded even with a large page count', () => {
    const { container } = renderPagination(50, 100)

    const compact = container.querySelector('span[class*="sm:hidden"]')
    expect(compact!.textContent).toBe('50 / 100')
    // 番号リストの件数が増えないこと（7ボタン + 省略記号2つまで）
    const numbers = container.querySelector('div[class*="sm:flex"]')
    expect(numbers!.querySelectorAll('button').length).toBeLessThanOrEqual(7)
  })

  it('still calls onPageChange via previous/next and keeps the current page marked', () => {
    const { onPageChange } = renderPagination(5, 20)

    fireEvent.click(screen.getByRole('button', { name: '前へ' }))
    expect(onPageChange).toHaveBeenCalledWith(4)
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    expect(onPageChange).toHaveBeenCalledWith(6)
  })
})
