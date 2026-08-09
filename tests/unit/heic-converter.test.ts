import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  isHeicUpload,
  convertHeicToJpeg,
  HEIC_INPUT_MAX_BYTES,
  HEIC_CONVERSION_TIMEOUT_MS,
  HEIC_ERROR_TOO_LARGE,
  HEIC_ERROR_CONVERT_FAILED,
  HEIC_ERROR_TIMEOUT,
} from '@/lib/heic-converter'

function makeFile(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type })
}

// heic-to の動的 import をモック（変換ユニット自体のテストに実ブラウザ変換は不要）
vi.mock('heic-to/csp', () => ({
  heicTo: vi.fn(),
}))

describe('isHeicUpload (issue #770)', () => {
  it('MIME が image/heic / image/heif のファイルを判定する', () => {
    expect(isHeicUpload(makeFile('photo.heic', 'image/heic'))).toBe(true)
    expect(isHeicUpload(makeFile('photo.heif', 'image/heif'))).toBe(true)
  })

  it('拡張子 .heic / .HEIC / .heif で判定する（File.type が空でも）', () => {
    expect(isHeicUpload(makeFile('photo.heic', ''))).toBe(true)
    expect(isHeicUpload(makeFile('photo.HEIC', 'application/octet-stream'))).toBe(true)
    expect(isHeicUpload(makeFile('photo.heif', ''))).toBe(true)
  })

  it('HEIC 以外（JPEG / PNG / GIF / WebP）を HEIC と誤判定しない', () => {
    expect(isHeicUpload(makeFile('photo.jpg', 'image/jpeg'))).toBe(false)
    expect(isHeicUpload(makeFile('photo.png', 'image/png'))).toBe(false)
    expect(isHeicUpload(makeFile('photo.gif', 'image/gif'))).toBe(false)
    expect(isHeicUpload(makeFile('photo.webp', 'image/webp'))).toBe(false)
  })
})

describe('convertHeicToJpeg (issue #770)', () => {
  let heicToMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    heicToMock = vi.mocked((await import('heic-to/csp')).heicTo)
    heicToMock.mockReset()
  })

  it('変換成功時に image/jpeg の File を返し、拡張子は .jpg になる', async () => {
    heicToMock.mockResolvedValue(new Blob(['jpeg-data'], { type: 'image/jpeg' }))
    const input = makeFile('photo.heic', 'image/heic')

    const result = await convertHeicToJpeg(input)

    expect(result.type).toBe('image/jpeg')
    expect(result.name).toBe('photo.jpg')
    expect(result.lastModified).toBe(input.lastModified)
    expect(heicToMock).toHaveBeenCalledWith(
      expect.objectContaining({ blob: input, type: 'image/jpeg', quality: 0.85 })
    )
  })

  it('複数画像を含む HEIC コンテナでは primary image（先頭）のみを使う', async () => {
    heicToMock.mockResolvedValue([
      new Blob(['primary'], { type: 'image/jpeg' }),
      new Blob(['secondary'], { type: 'image/jpeg' }),
    ])

    const result = await convertHeicToJpeg(makeFile('photo.heic', 'image/heic'))

    expect(await result.text()).toBe('primary')
  })

  it('変換失敗時は HEIC_CONVERT_FAILED エラーを投げる', async () => {
    heicToMock.mockRejectedValue(new Error('decode failed'))

    await expect(convertHeicToJpeg(makeFile('photo.heic', 'image/heic'))).rejects.toThrow(
      HEIC_ERROR_CONVERT_FAILED
    )
  })

  it('変換が応答しない場合はタイムアウトして HEIC_CONVERSION_TIMEOUT を投げる', async () => {
    vi.useFakeTimers()
    try {
      heicToMock.mockImplementation(() => new Promise<Blob>(() => undefined))

      const conversion = convertHeicToJpeg(makeFile('photo.heic', 'image/heic'))
      // rejection handlerを先に接続し、タイマー発火とアサーションの間に
      // Vitestが一時的な未処理rejectionとして扱わないようにする。
      const rejection = expect(conversion).rejects.toThrow(HEIC_ERROR_TIMEOUT)
      // 動的 import のmicrotaskを先に進め、変換Promiseがタイマーを登録してから時間を進める
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(HEIC_CONVERSION_TIMEOUT_MS)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('空の出力（サイズ0）は HEIC_CONVERT_FAILED として扱う', async () => {
    heicToMock.mockResolvedValue(new Blob([]))

    await expect(convertHeicToJpeg(makeFile('photo.heic', 'image/heic'))).rejects.toThrow(
      HEIC_ERROR_CONVERT_FAILED
    )
  })

  it('入力サイズが上限を超える場合は変換せず HEIC_TOO_LARGE を投げる', async () => {
    const oversized = makeFile('big.heic', 'image/heic', HEIC_INPUT_MAX_BYTES + 1)

    await expect(convertHeicToJpeg(oversized)).rejects.toThrow(HEIC_ERROR_TOO_LARGE)
    expect(heicToMock).not.toHaveBeenCalled()
  })

  it('変換が応答しない場合はタイムアウトして HEIC_CONVERSION_TIMEOUT を投げる', async () => {
    vi.useFakeTimers()
    try {
      heicToMock.mockImplementation(() => new Promise<Blob>(() => undefined))

      const conversion = convertHeicToJpeg(makeFile('photo.heic', 'image/heic'))
      // rejection handlerを先に接続し、タイマー発火とアサーションの間に
      // Vitestが一時的な未処理rejectionとして扱わないようにする。
      const rejection = expect(conversion).rejects.toThrow(HEIC_ERROR_TIMEOUT)
      // 動的 import のmicrotaskを先に進め、変換Promiseがタイマーを登録してから時間を進める
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(HEIC_CONVERSION_TIMEOUT_MS)

      await rejection
    } finally {
      vi.useRealTimers()
    }
  })
})
