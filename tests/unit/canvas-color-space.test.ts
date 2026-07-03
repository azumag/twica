import { describe, it, expect, vi } from 'vitest'
import { getColorManaged2DContext } from '@/lib/canvas-color-space'

// getColorManaged2DContext は Issue #615（高解像度画像アップロード時の明度低下）対策として
// Display P3 canvas コンテキストを優先的に取得し、非対応環境ではsRGBにフォールバックする。
// 実際のcanvas 2Dレンダリング（ピクセル/色の検証）はこの環境では検証できないため、
// canvas.getContext の呼び出しに対するフォールバック制御フローのみを検証する。

type FakeContext = { __brand: string }

function createFakeCanvas(
  getContextImpl: (contextId: string, options?: { colorSpace?: string }) => FakeContext | null
): HTMLCanvasElement {
  return {
    getContext: vi.fn(getContextImpl),
  } as unknown as HTMLCanvasElement
}

describe('getColorManaged2DContext', () => {
  it('display-p3 コンテキストが取得できる場合はそれを返す', () => {
    const p3Context: FakeContext = { __brand: 'p3' }
    const canvas = createFakeCanvas((_id, options) =>
      options?.colorSpace === 'display-p3' ? p3Context : { __brand: 'srgb' }
    )

    const ctx = getColorManaged2DContext(canvas)

    expect(ctx).toBe(p3Context)
    expect(canvas.getContext).toHaveBeenCalledWith('2d', { colorSpace: 'display-p3' })
    // sRGBへのフォールバックは発生しない（P3が取得できた時点で追加呼び出し不要）
    expect(canvas.getContext).toHaveBeenCalledTimes(1)
  })

  it('display-p3 指定でTypeErrorが投げられる場合（例: 要件を満たさないSafari）はsRGBにフォールバックする', () => {
    const srgbContext: FakeContext = { __brand: 'srgb' }
    const canvas = createFakeCanvas((_id, options) => {
      if (options?.colorSpace === 'display-p3') {
        throw new TypeError('display-p3 not supported on this system')
      }
      return srgbContext
    })

    const ctx = getColorManaged2DContext(canvas)

    expect(ctx).toBe(srgbContext)
    expect(canvas.getContext).toHaveBeenNthCalledWith(1, '2d', { colorSpace: 'display-p3' })
    expect(canvas.getContext).toHaveBeenNthCalledWith(2, '2d')
  })

  it('display-p3 指定でnullが返る場合（例: Firefox等の非対応ブラウザ）はsRGBにフォールバックする', () => {
    const srgbContext: FakeContext = { __brand: 'srgb' }
    const canvas = createFakeCanvas((_id, options) =>
      options?.colorSpace === 'display-p3' ? null : srgbContext
    )

    const ctx = getColorManaged2DContext(canvas)

    expect(ctx).toBe(srgbContext)
  })

  it('sRGBコンテキストも取得できない場合はnullを返す', () => {
    const canvas = createFakeCanvas(() => null)

    const ctx = getColorManaged2DContext(canvas)

    expect(ctx).toBeNull()
  })
})
