import { describe, it, expect } from 'vitest'
import {
  DEFAULT_OVERLAY_EFFECT_STYLE,
  OVERLAY_EFFECT_STYLES,
  normalizeOverlayEffectStyle,
} from '@/lib/overlay-effect'

describe('overlay-effect: normalizeOverlayEffectStyle', () => {
  it('既知のスタイル文字列はそのまま返す', () => {
    for (const style of OVERLAY_EFFECT_STYLES) {
      expect(normalizeOverlayEffectStyle(style)).toBe(style)
    }
  })

  it('未知文字列はデフォルトに丸める', () => {
    expect(normalizeOverlayEffectStyle('unknown')).toBe(DEFAULT_OVERLAY_EFFECT_STYLE)
    expect(normalizeOverlayEffectStyle('')).toBe(DEFAULT_OVERLAY_EFFECT_STYLE)
    expect(normalizeOverlayEffectStyle('SPARKLE')).toBe(DEFAULT_OVERLAY_EFFECT_STYLE)
  })

  it('null / undefined / 非文字列はデフォルトに丸める', () => {
    expect(normalizeOverlayEffectStyle(null)).toBe(DEFAULT_OVERLAY_EFFECT_STYLE)
    expect(normalizeOverlayEffectStyle(undefined)).toBe(DEFAULT_OVERLAY_EFFECT_STYLE)
    expect(normalizeOverlayEffectStyle(0)).toBe(DEFAULT_OVERLAY_EFFECT_STYLE)
    expect(normalizeOverlayEffectStyle({})).toBe(DEFAULT_OVERLAY_EFFECT_STYLE)
  })

  it('全ての登録スタイルがデフォルトを含む', () => {
    expect(OVERLAY_EFFECT_STYLES).toContain(DEFAULT_OVERLAY_EFFECT_STYLE)
  })
})
