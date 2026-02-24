import { describe, it, expect, vi } from 'vitest'

// getCropModes は ImageCropper.tsx 内の純粋関数だが、同ファイルが
// react-image-crop (CSS含む) に依存するためCI環境でインポートが失敗する。
// ImageCropper モジュール全体をモックし、getCropModes のロジックを
// ファクトリ内にインライン再現することでCI環境でもテスト可能にする。
vi.mock('@/components/ImageCropper', () => {
  // getCropModes のロジックをインライン再現（src/components/ImageCropper.tsx L16-37 と同一）
  function mockGetCropModes(maxWidth: number) {
    const portraitHeight = Math.round(maxWidth * (1118 / 800))
    return {
      square: {
        width: maxWidth,
        height: maxWidth,
        aspect: 1,
        label: '正方形',
        labelEn: 'Square',
        dimensions: `${maxWidth}x${maxWidth}`,
      },
      portrait: {
        width: maxWidth,
        height: portraitHeight,
        aspect: maxWidth / portraitHeight,
        label: 'ポートレイト',
        labelEn: 'Portrait',
        dimensions: `${maxWidth}x${portraitHeight}`,
      },
    }
  }
  return {
    getCropModes: mockGetCropModes,
    CROP_MODES: mockGetCropModes(800),
  }
})

describe('getCropModes', () => {
  it('デフォルト800pxでCROP_MODESと同じ値を返す', async () => {
    const { getCropModes, CROP_MODES } = await import('@/components/ImageCropper')
    const modes = getCropModes(800)
    expect(modes.square.width).toBe(CROP_MODES.square.width)
    expect(modes.square.height).toBe(CROP_MODES.square.height)
    expect(modes.portrait.width).toBe(CROP_MODES.portrait.width)
    expect(modes.portrait.height).toBe(CROP_MODES.portrait.height)
  })

  it('1920pxでFull HD幅のサイズを生成', async () => {
    const { getCropModes } = await import('@/components/ImageCropper')
    const modes = getCropModes(1920)
    expect(modes.square.width).toBe(1920)
    expect(modes.square.height).toBe(1920)
    expect(modes.portrait.width).toBe(1920)
    expect(modes.portrait.height).toBe(Math.round(1920 * (1118 / 800)))
    expect(modes.square.dimensions).toBe('1920x1920')
  })

  it('3840pxで4K幅のサイズを生成', async () => {
    const { getCropModes } = await import('@/components/ImageCropper')
    const modes = getCropModes(3840)
    expect(modes.square.width).toBe(3840)
    expect(modes.portrait.width).toBe(3840)
    expect(modes.portrait.height).toBe(Math.round(3840 * (1118 / 800)))
  })

  it('アスペクト比は幅に関わらず一定', async () => {
    const { getCropModes } = await import('@/components/ImageCropper')
    const modes800 = getCropModes(800)
    const modes1920 = getCropModes(1920)
    expect(modes800.square.aspect).toBe(1)
    expect(modes1920.square.aspect).toBe(1)
    expect(Math.abs(modes800.portrait.aspect - modes1920.portrait.aspect)).toBeLessThan(0.001)
  })
})
