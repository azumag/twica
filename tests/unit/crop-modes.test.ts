import { describe, it, expect, vi } from 'vitest'

// react-image-crop をモック（CI環境ではCSSインポートが失敗するため）
vi.mock('react-image-crop', () => ({
  default: vi.fn(),
  centerCrop: vi.fn(),
  makeAspectCrop: vi.fn(),
}))
vi.mock('react-image-crop/dist/ReactCrop.css', () => ({}))

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
    // 高さはアスペクト比 1118/800 を維持
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
    // 正方形のアスペクト比は常に1
    expect(modes800.square.aspect).toBe(1)
    expect(modes1920.square.aspect).toBe(1)
    // ポートレイトのアスペクト比は許容誤差0.001以内で同じ
    expect(Math.abs(modes800.portrait.aspect - modes1920.portrait.aspect)).toBeLessThan(0.001)
  })
})
