import { afterEach, describe, expect, it, vi } from 'vitest'
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
//
// 注意: jsdom は scrollHeight/clientHeight を HTMLElement.prototype ではなく
// Element.prototype 上に定義しているため、HTMLElement.prototype を対象にした
// getOwnPropertyDescriptor は常に undefined を返す。そのため必ず
// Object.defineProperty で「値」を直接上書きすることになり、これは vi.spyOn の
// モックではないので vi.restoreAllMocks() では元に戻らない。復元し忘れると
// HTMLElement.prototype が恒久的に汚染され、後続のテスト（省略なしの状態を
// 期待するテスト等）が誤った値を読むことになる。そのため元のディスクリプタを
// 保存しておき、afterEach で必ず明示的に復元する。
//
// Note: jsdom defines scrollHeight/clientHeight on Element.prototype, not
// HTMLElement.prototype, so a lookup against HTMLElement.prototype always
// finds no descriptor. We therefore always overwrite it with a plain value via
// Object.defineProperty, which vi.restoreAllMocks() cannot undo (it only knows
// about vi.spyOn mocks). Without explicit restoration this permanently
// pollutes HTMLElement.prototype for every later test in this file — so we
// save the original descriptors and restore them in afterEach.
let savedScrollHeightDescriptor: PropertyDescriptor | undefined
let savedClientHeightDescriptor: PropertyDescriptor | undefined

function stubTruncation() {
  const proto = HTMLElement.prototype
  savedScrollHeightDescriptor = Object.getOwnPropertyDescriptor(proto, 'scrollHeight')
  savedClientHeightDescriptor = Object.getOwnPropertyDescriptor(proto, 'clientHeight')
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, value: 100 })
  Object.defineProperty(proto, 'clientHeight', { configurable: true, value: 50 })
}

afterEach(() => {
  const proto = HTMLElement.prototype
  if (savedScrollHeightDescriptor) {
    Object.defineProperty(proto, 'scrollHeight', savedScrollHeightDescriptor)
  } else {
    delete (proto as unknown as Record<string, unknown>).scrollHeight
  }
  if (savedClientHeightDescriptor) {
    Object.defineProperty(proto, 'clientHeight', savedClientHeightDescriptor)
  } else {
    delete (proto as unknown as Record<string, unknown>).clientHeight
  }
  savedScrollHeightDescriptor = undefined
  savedClientHeightDescriptor = undefined
})

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

  // 回帰テスト: 省略されていない（isTruncated=false）短い説明文をクリックした場合は
  // 内部的にトグルが発生しないため、これまで通りクリックが親（カード詳細への Link）へ
  // 伝播し、カード全体がクリック可能な領域として機能し続けることを確認する。
  // stopPropagation を条件外で無条件に呼んでしまうと、この伝播が止まり、
  // 説明文の領域だけクリックしても何も起きない死角が生まれてしまう。
  it('省略されていない説明テキストのクリックは親の onClick に伝播する（カード全体のクリック可能性を維持）', () => {
    // stubTruncation() を呼ばないことで scrollHeight === clientHeight（省略なし）の状態を維持する
    const parentClick = vi.fn()

    render(
      <div onClick={parentClick}>
        <ExpandableDescription description="短い説明" maxLines={2} />
      </div>
    )

    fireEvent.click(screen.getByText('短い説明'))
    expect(parentClick).toHaveBeenCalledTimes(1)
  })
})
