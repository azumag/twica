import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ExpandableDescription from '@/components/ExpandableDescription'

// next-intl のモック: キーをそのまま返す（「開く/閉じる」の文言検証は不要）
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

// コレクションページ等でカード全体が <Link>(詳細遷移) でラップされているため、
// 「開く/閉じる」のクリックが親へバブリングして詳細画面へ同時遷移してしまう問題の回帰テスト。
// ExpandableDescription は scrollHeight > clientHeight で省略判定するため、
// テスト環境（レイアウト計算なし）ではプロパティをモックして「省略状態」を作る。
function stubTruncation() {
  const proto = HTMLElement.prototype as any
  const desc = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')
  // 既存ゲッターが定義されている場合は spyOn で上書き、無ければ defineProperty
  if (desc && 'get' in desc) {
    vi.spyOn(proto, 'scrollHeight', 'get').mockReturnValue(100)
    vi.spyOn(proto, 'clientHeight', 'get').mockReturnValue(50)
  } else {
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, value: 100 })
    Object.defineProperty(proto, 'clientHeight', { configurable: true, value: 50 })
  }
}

describe('ExpandableDescription (issue: カード詳細への同時遷移防止)', () => {
  it('「開く」ボタンのクリックは親の onClick（Link 遷移）に伝播しない', () => {
    stubTruncation()
    const parentClick = vi.fn()

    render(
      <div onClick={parentClick}>
        <ExpandableDescription description="長い説明テキスト" maxLines={2} />
      </div>
    )

    // 省略状態なので「開く」ボタンが表示される（▼ 記号がアクセシブルネームに含まれるため正規表現で探す）
    const expandButton = screen.getByRole('button', { name: /expand/ })
    fireEvent.click(expandButton)

    expect(parentClick).not.toHaveBeenCalled()
  })

  it('説明テキスト自体のクリックも親の onClick に伝播しない', () => {
    stubTruncation()
    const parentClick = vi.fn()

    render(
      <div onClick={parentClick}>
        <ExpandableDescription description="長い説明テキスト" maxLines={2} />
      </div>
    )

    fireEvent.click(screen.getByText('長い説明テキスト'))
    expect(parentClick).not.toHaveBeenCalled()
  })

  it('展開後の「閉じる」ボタンのクリックも親の onClick に伝播しない', () => {
    stubTruncation()
    const parentClick = vi.fn()

    render(
      <div onClick={parentClick}>
        <ExpandableDescription description="長い説明テキスト" maxLines={2} />
      </div>
    )

    fireEvent.click(screen.getByRole('button', { name: /expand/ }))
    fireEvent.click(screen.getByRole('button', { name: /collapse/ }))

    expect(parentClick).not.toHaveBeenCalled()
  })
})
