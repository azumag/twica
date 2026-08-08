import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CardManager from '@/components/CardManager'
import jaMessages from '../../../messages/ja.json'

// heic-converter をモックし、実ブラウザ変換（wasm）に依存しないテストにする
const mocks = vi.hoisted(() => ({
  isHeicUpload: vi.fn(),
  convertHeicToJpeg: vi.fn(),
}))

vi.mock('@/lib/heic-converter', () => ({
  isHeicUpload: mocks.isHeicUpload,
  convertHeicToJpeg: mocks.convertHeicToJpeg,
  HEIC_INPUT_MAX_BYTES: 25 * 1024 * 1024,
  HEIC_ERROR_TOO_LARGE: 'HEIC_TOO_LARGE',
  HEIC_ERROR_CONVERT_FAILED: 'HEIC_CONVERT_FAILED',
}))

vi.mock('@/lib/logger')

// happy-dom は blob URL に対する img の読み込みイベント（onload/onerror）を発火しないため、
// src が設定されたら onload を呼び出すスタブで、クロップモーダルが開くまでの既存フローを
// テストで再現する。
function stubImageLoad() {
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLImageElement
  ) {
    // 読み込みは非同期で完了する想定（React のコールバックにそのまま乗せない）
    setTimeout(() => this.onload?.(new Event('load')), 0)
  })
}

function renderCardManager({ strictMode = false }: { strictMode?: boolean } = {}) {
  const content = (
    <NextIntlClientProvider locale="ja" messages={jaMessages}>
      <CardManager
        streamerId="streamer-1"
        initialCards={[]}
        initialRarityWeights={{}}
      />
    </NextIntlClientProvider>
  )
  return render(strictMode ? <StrictMode>{content}</StrictMode> : content)
}

function openFormAndSelectFile(container: HTMLElement, file: File) {
  // カードが空の初期状態ではフォームが開いていないため、「新規カード追加」で開く
  fireEvent.click(screen.getByText('新規カード追加'))
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

const heicFile = () => new File([new Uint8Array(1024)], 'photo.heic', { type: 'image/heic' })
const jpegFile = () => new File(['jpeg-data'], 'photo.jpg', { type: 'image/jpeg' })

describe('CardManager HEIC conversion (issue #770)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('HEIC選択時に変換中表示を出し、変換完了後はクロップモード選択モーダルが開く', async () => {
    stubImageLoad()
    mocks.isHeicUpload.mockReturnValue(true)
    // 変換完了まで pending にする（変換中表示の確認のため）
    let resolveConvert: (file: File) => void
    mocks.convertHeicToJpeg.mockImplementation(
      () => new Promise<File>((resolve) => { resolveConvert = resolve })
    )
    const { container } = renderCardManager()

    openFormAndSelectFile(container, heicFile())

    // 変換中はステータス表示が出て、ファイル入力が無効化される
    expect(await screen.findByRole('status')).toHaveTextContent('HEIC画像を変換中…')
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.disabled).toBe(true)

    // 変換完了 → 変換済み JPEG で既存フロー（クロップモード選択）が進む
    resolveConvert!(jpegFile())
    expect(await screen.findByText('トリミングサイズを選択')).toBeInTheDocument()
    expect(screen.queryByText('HEIC画像を変換中…')).not.toBeInTheDocument()
    expect(mocks.convertHeicToJpeg).toHaveBeenCalledTimes(1)
  })

  it('変換失敗時はエラーを表示し、HEIC原本は既存フローへ渡らない', async () => {
    mocks.isHeicUpload.mockReturnValue(true)
    mocks.convertHeicToJpeg.mockRejectedValue(new Error('HEIC_CONVERT_FAILED'))
    const { container } = renderCardManager()

    openFormAndSelectFile(container, heicFile())

    expect(
      await screen.findByText('HEIC画像を読み込めませんでした。別の画像を選択するか、JPEGへ変換してから再度お試しください。')
    ).toBeInTheDocument()
    // 変換後は入力が再度有効になる
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.disabled).toBe(false)
    // クロップモーダルは開かない
    expect(screen.queryByText('トリミングサイズを選択')).not.toBeInTheDocument()
  })

  it('タイムアウトエラー時も変換中表示を解除し、再選択できる状態に戻る', async () => {
    mocks.isHeicUpload.mockReturnValue(true)
    mocks.convertHeicToJpeg.mockRejectedValue(new Error('HEIC_CONVERSION_TIMEOUT'))
    const { container } = renderCardManager()

    openFormAndSelectFile(container, heicFile())

    // 実タイマーを30秒進めるテストはconverter単体で行い、ここではタイムアウトが
    // コンポーネントへ届いた後の利用者向け終了状態を固定する。
    expect(
      await screen.findByText('HEIC画像を読み込めませんでした。別の画像を選択するか、JPEGへ変換してから再度お試しください。')
    ).toBeInTheDocument()
    expect(screen.queryByText('HEIC画像を変換中…')).not.toBeInTheDocument()
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(false)
    expect(screen.queryByText('トリミングサイズを選択')).not.toBeInTheDocument()
  })

  it('サイズ上限超過時は専用エラーを表示する', async () => {
    mocks.isHeicUpload.mockReturnValue(true)
    mocks.convertHeicToJpeg.mockRejectedValue(new Error('HEIC_TOO_LARGE'))
    const { container } = renderCardManager()

    openFormAndSelectFile(container, heicFile())

    expect(
      await screen.findByText('HEIC画像のサイズが大きすぎます。25MB以下の画像を選択してください。')
    ).toBeInTheDocument()
  })

  it('HEIC以外の通常ファイルは変換処理を呼ばず既存フローへ進む', async () => {
    stubImageLoad()
    mocks.isHeicUpload.mockReturnValue(false)
    const { container } = renderCardManager()

    openFormAndSelectFile(container, new File([new Uint8Array(1024)], 'photo.jpg', { type: 'image/jpeg' }))

    expect(mocks.convertHeicToJpeg).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    // 既存フロー（クロップモード選択）が通常どおり進む
    expect(await screen.findByText('トリミングサイズを選択')).toBeInTheDocument()
  })

  it('変換中にフォームをキャンセルした場合は、古い変換結果が反映されない', async () => {
    stubImageLoad()
    mocks.isHeicUpload.mockReturnValue(true)
    let resolveConvert: (file: File) => void
    mocks.convertHeicToJpeg.mockImplementation(
      () => new Promise<File>((resolve) => { resolveConvert = resolve })
    )
    const { container } = renderCardManager()

    openFormAndSelectFile(container, heicFile())
    expect(await screen.findByRole('status')).toHaveTextContent('HEIC画像を変換中…')

    // 変換中にフォームをキャンセル（resetForm が request id を進める）
    fireEvent.click(screen.getByText('キャンセル'))

    // 変換は後から完了するが、request id の不一致により結果は破棄される
    resolveConvert!(jpegFile())
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('トリミングサイズを選択')).not.toBeInTheDocument()
    expect(screen.queryByText('HEIC画像を読み込めませんでした。別の画像を選択するか、JPEGへ変換してから再度お試しください。')).not.toBeInTheDocument()
  })

  it('キャンセル後に開き直したフォームの変換状態を、古い変換が解除しない', async () => {
    stubImageLoad()
    mocks.isHeicUpload.mockReturnValue(true)
    let resolveFirst: (file: File) => void
    let resolveSecond: (file: File) => void
    let conversionCount = 0
    mocks.convertHeicToJpeg.mockImplementation(
      () => new Promise<File>((resolve) => {
        if (conversionCount++ === 0) {
          resolveFirst = resolve
        } else {
          resolveSecond = resolve
        }
      })
    )
    const { container } = renderCardManager()

    openFormAndSelectFile(container, heicFile())
    expect(await screen.findByRole('status')).toHaveTextContent('HEIC画像を変換中…')
    fireEvent.click(screen.getByText('キャンセル'))

    // 古い変換が未完了でも、キャンセル後は状態を持ち越さず新規フォームを開ける
    openFormAndSelectFile(container, heicFile())
    expect(await screen.findByRole('status')).toHaveTextContent('HEIC画像を変換中…')

    // 古い変換の finally が実行されても、現在の変換中表示は維持する
    resolveFirst!(jpegFile())
    await waitFor(() => expect(mocks.convertHeicToJpeg).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status')).toHaveTextContent('HEIC画像を変換中…')

    resolveSecond!(jpegFile())
    expect(await screen.findByText('トリミングサイズを選択')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('Strict Modeでも変換完了後に既存フローへ進める', async () => {
    stubImageLoad()
    mocks.isHeicUpload.mockReturnValue(true)
    mocks.convertHeicToJpeg.mockResolvedValue(jpegFile())
    const { container } = renderCardManager({ strictMode: true })

    openFormAndSelectFile(container, heicFile())

    // Strict Modeの検証用cleanup後も、現行setupがマウント中として扱われることを確認する。
    expect(await screen.findByText('トリミングサイズを選択')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('アンマウント後に遅延した変換結果を反映しない', async () => {
    mocks.isHeicUpload.mockReturnValue(true)
    let resolveConvert: (file: File) => void
    mocks.convertHeicToJpeg.mockImplementation(
      () => new Promise<File>((resolve) => { resolveConvert = resolve })
    )
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    const { container, unmount } = renderCardManager()

    openFormAndSelectFile(container, heicFile())
    expect(await screen.findByRole('status')).toHaveTextContent('HEIC画像を変換中…')

    unmount()
    resolveConvert!(jpegFile())
    await Promise.resolve()
    await Promise.resolve()

    // アンマウント済みのコンポーネントに対する遅延結果は、クロップ開始に必要な
    // object URL作成まで到達しない。DOMが消えたことだけではこのガードの回帰を
    // 検出できないため、結果を処理した場合に必ず発生する副作用を直接検証する。
    expect(createObjectURLSpy).not.toHaveBeenCalled()
  })
})
