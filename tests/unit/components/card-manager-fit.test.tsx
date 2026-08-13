import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CardManager from '@/components/CardManager'
import jaMessages from '../../../messages/ja.json'

vi.mock('@/lib/logger')

// happy-dom は blob URL に対する img の読み込みイベントを発火しないため、
// src 設定時に onload を呼び出すスタブで、クロップモード選択モーダルまでのフローを再現する。
// issue #947 以降は naturalWidth/naturalHeight が 0 だとデコード失敗として扱われるため、
// 正常系のスタブでは非0寸法を返す。
function stubImageLoad() {
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(800)
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLImageElement
  ) {
    setTimeout(() => this.onload?.(new Event('load')), 0)
  })
}

function renderCardManager() {
  return render(
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <CardManager
        streamerId="streamer-1"
        initialCards={[]}
        initialRarityWeights={{}}
      />
    </NextIntlClientProvider>
  )
}

async function openCropModeModal(container: HTMLElement) {
  fireEvent.click(screen.getByText('新規カード追加'))
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array(1024)], 'photo.jpg', { type: 'image/jpeg' })] },
  })
  // img の onload 後にクロップモード選択モーダルが開く
  await screen.findByText('トリミングサイズを選択')
}

describe('CardManager fit mode (issue #899)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('「余白を追加」を選ぶと色選択 UI が表示される', async () => {
    stubImageLoad()
    const { container } = renderCardManager()
    await openCropModeModal(container)

    fireEvent.click(screen.getByText('余白を追加'))

    // 色選択 UI（黒/白/グレー/透明）が表示される
    expect(screen.getByText('余白の色')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '黒' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '白' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'グレー' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '透明（PNG）' })).toBeInTheDocument()
  })

  it('色を選んで「この色で余白を追加」で余白モードのクロッパーが開く', async () => {
    stubImageLoad()
    const { container } = renderCardManager()
    await openCropModeModal(container)

    fireEvent.click(screen.getByText('余白を追加'))
    fireEvent.click(screen.getByRole('button', { name: '透明（PNG）' }))
    fireEvent.click(screen.getByText('この色で余白を追加'))

    // 余白モードのクロッパー(画像全体を収める説明)が表示される
    expect(screen.getByText(/画像全体が800x800に収まるよう、余白を追加します/)).toBeInTheDocument()
  })

  it('正方形・ポートレイトは従来どおり即トリミングへ進む（色選択 UI は出ない）', async () => {
    stubImageLoad()
    const { container } = renderCardManager()
    await openCropModeModal(container)

    fireEvent.click(screen.getByText('正方形'))

    expect(screen.queryByText('余白の色')).not.toBeInTheDocument()
    expect(screen.getByText(/ドラッグして位置とサイズを調整してください/)).toBeInTheDocument()
  })
})
