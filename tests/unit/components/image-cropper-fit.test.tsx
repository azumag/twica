import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ImageCropper, { getCropModes, FIT_COLORS, computeFitDrawRect } from '@/components/ImageCropper'

// Issue #899: 余白（fit）モード
// レンダー検証のみ（canvas 描画・toBlob は実ブラウザ依存のため、モード選択と
// 表示文言の確認に留める。描画ロジックの検証はカード管理の統合テストで担保）。

function makeImageFile(): File {
  return new File([new Uint8Array(1024)], 'photo.jpg', { type: 'image/jpeg' })
}

describe('getCropModes fit mode (issue #899)', () => {
  it('fit は正方形（maxWidth x maxWidth）の出力設定を持つ', () => {
    const modes = getCropModes(800)
    expect(modes.fit).toEqual({
      width: 800,
      height: 800,
      aspect: 1,
      label: '余白を追加',
      labelEn: 'Fit with padding',
      dimensions: '800x800',
    })
  })

  it('プラン別 maxWidth に追従する', () => {
    expect(getCropModes(1920).fit.width).toBe(1920)
    expect(getCropModes(1920).fit.height).toBe(1920)
  })

  it('余白の色マップは黒・白・グレーを持つ', () => {
    expect(FIT_COLORS).toEqual({
      black: '#000000',
      white: '#FFFFFF',
      gray: '#808080',
    })
  })
})

describe('ImageCropper fit mode rendering (issue #899)', () => {
  it('fit モードではトリミング案内ではなく余白の説明が表示される', () => {
    render(
      <ImageCropper
        imageFile={makeImageFile()}
        cropMode="fit"
        onCropComplete={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText(/画像全体が800x800に収まるよう、余白を追加します/)).toBeInTheDocument()
    expect(screen.queryByText(/ドラッグして位置とサイズを調整してください/)).not.toBeInTheDocument()
  })

  it('通常の square モードでは従来どおりトリミング案内が表示される', () => {
    render(
      <ImageCropper
        imageFile={makeImageFile()}
        cropMode="square"
        onCropComplete={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText(/ドラッグして位置とサイズを調整してください/)).toBeInTheDocument()
  })
})

describe('computeFitDrawRect (issue #899)', () => {
  it('横長画像(1920x1080)を800x800へ収めると上下に余白が入る', () => {
    const rect = computeFitDrawRect(1920, 1080, 800, 800)
    // 幅基準でスケール: 800/1920 ≈ 0.4167 → 高さ 450、上下に (800-450)/2 = 175px の余白
    expect(rect.width).toBeCloseTo(800)
    expect(rect.height).toBeCloseTo(450)
    expect(rect.x).toBe(0)
    expect(rect.y).toBeCloseTo(175)
  })

  it('縦長画像(1080x1920)を800x800へ収めると上下に余白が入る', () => {
    const rect = computeFitDrawRect(1080, 1920, 800, 800)
    expect(rect.width).toBeCloseTo(450)
    expect(rect.height).toBeCloseTo(800)
    expect(rect.x).toBe(175)
    expect(rect.y).toBe(0)
  })

  it('正方形画像は余白なしで全体を埋める', () => {
    const rect = computeFitDrawRect(800, 800, 800, 800)
    expect(rect).toEqual({ x: 0, y: 0, width: 800, height: 800 })
  })

  it('アスペクト比が同じ画像はスケールが1になる', () => {
    const rect = computeFitDrawRect(400, 400, 800, 800)
    expect(rect).toEqual({ x: 0, y: 0, width: 800, height: 800 })
  })
})
