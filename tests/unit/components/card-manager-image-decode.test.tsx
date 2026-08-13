import { fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CardManager from '@/components/CardManager'
import jaMessages from '../../../messages/ja.json'

vi.mock('@/lib/logger')

const DECODE_ERROR_MESSAGE = '画像を読み込めませんでした。別の画像を選択してください。'

// happy-dom は blob URL に対する img の読み込みイベントを発火しないため、
// src 設定時に onload/onerror を手動発火するスタブでデコード結果を再現する。
// naturalWidth/naturalHeight は issue #947 の 0 寸法判定を検証できるよう
// テストごとに差し替える。
function stubImageLoad({
  width = 800,
  height = 800,
}: { width?: number; height?: number } = {}) {
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(width)
  vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(height)
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLImageElement
  ) {
    setTimeout(() => this.onload?.(new Event('load')), 0)
  })
}

function stubImageError() {
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLImageElement
  ) {
    setTimeout(() => this.onerror?.(new Event('error')), 0)
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

function selectBrokenFile(container: HTMLElement, name = 'broken.png') {
  fireEvent.click(screen.getByText('新規カード追加'))
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, {
    target: {
      files: [new File(['this is not an image'], name, { type: 'image/png' })],
    },
  })
}

describe('CardManager image decode failure (issue #947)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('onerror 時に安全なエラーを表示し、トリミングモーダルを開かない', async () => {
    stubImageError()
    const { container } = renderCardManager()
    selectBrokenFile(container)

    expect(await screen.findByText(DECODE_ERROR_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByText('トリミングサイズを選択')).not.toBeInTheDocument()
  })

  it('エラー文にファイル名・MIME・サイズを含めない', async () => {
    stubImageError()
    const { container } = renderCardManager()
    selectBrokenFile(container, 'secret-name.png')

    await screen.findByText(DECODE_ERROR_MESSAGE)
    expect(screen.queryByText(/secret-name/)).not.toBeInTheDocument()
    expect(screen.queryByText(/image\/png/)).not.toBeInTheDocument()
    expect(screen.queryByText(/21/)).not.toBeInTheDocument()
  })

  it('naturalWidth が 0 の onload は読み込み失敗として扱う', async () => {
    stubImageLoad({ width: 0, height: 800 })
    const { container } = renderCardManager()
    selectBrokenFile(container)

    expect(await screen.findByText(DECODE_ERROR_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByText('トリミングサイズを選択')).not.toBeInTheDocument()
  })

  it('naturalHeight が 0 の onload は読み込み失敗として扱う', async () => {
    stubImageLoad({ width: 800, height: 0 })
    const { container } = renderCardManager()
    selectBrokenFile(container)

    expect(await screen.findByText(DECODE_ERROR_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByText('トリミングサイズを選択')).not.toBeInTheDocument()
  })

  it('正常な寸法の画像は従来どおりトリミングモーダルが開く', async () => {
    stubImageLoad()
    const { container } = renderCardManager()
    selectBrokenFile(container)

    expect(await screen.findByText('トリミングサイズを選択')).toBeInTheDocument()
    expect(screen.queryByText(DECODE_ERROR_MESSAGE)).not.toBeInTheDocument()
  })

  it('フォームをキャンセルした後は古い onerror がエラーを出さない', async () => {
    const createdImages: HTMLImageElement[] = []
    const originalCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = originalCreateElement(tag)
      if (tag === 'img') {
        createdImages.push(element as HTMLImageElement)
      }
      return element
    })
    const { container } = renderCardManager()
    selectBrokenFile(container)

    // フォームのキャンセルで世代IDが進む（resetForm）
    fireEvent.click(screen.getByText('キャンセル'))
    createdImages[0]?.onerror?.(new Event('error'))

    expect(screen.queryByText(DECODE_ERROR_MESSAGE)).not.toBeInTheDocument()
    expect(screen.queryByText('トリミングサイズを選択')).not.toBeInTheDocument()
  })
})
