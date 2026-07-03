import { describe, it, expect } from 'vitest'
import {
  DEFAULT_OVERLAY_EFFECT_STYLE,
  OVERLAY_EFFECT_STYLES,
  OVERLAY_EFFECT_PARTICLE_COUNT,
  OVERLAY_EFFECT_PARTICLE_CONFIG,
  normalizeOverlayEffectStyle,
  generateOverlayEffectParticles,
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

describe('overlay-effect: OVERLAY_EFFECT_PARTICLE_CONFIG', () => {
  it('全スタイル分の設定が存在する', () => {
    for (const style of OVERLAY_EFFECT_STYLES) {
      expect(OVERLAY_EFFECT_PARTICLE_CONFIG[style]).toBeDefined()
    }
  })

  it('sparkle は既存のアニメーション（animate-ping）を維持する（回帰防止）', () => {
    expect(OVERLAY_EFFECT_PARTICLE_CONFIG.sparkle.animationClassName).toBe('animate-ping')
  })

  it('Issue #587: confetti / hearts は sparkle や互いと異なる専用アニメーションを持つ', () => {
    const { sparkle, confetti, hearts } = OVERLAY_EFFECT_PARTICLE_CONFIG
    const classNames = [sparkle.animationClassName, confetti.animationClassName, hearts.animationClassName]
    expect(new Set(classNames).size).toBe(3)
    // 旧実装のバグ（confetti/heartsが同じanimate-bounceを共有）の再発防止
    expect(confetti.animationClassName).not.toBe('animate-bounce')
    expect(hearts.animationClassName).not.toBe('animate-bounce')
  })

  it('confetti はカード上端付近（top<=8%）から出現する', () => {
    const [minTop, maxTop] = OVERLAY_EFFECT_PARTICLE_CONFIG.confetti.spawnTopPercentRange
    expect(minTop).toBeLessThanOrEqual(0)
    expect(maxTop).toBeLessThanOrEqual(10)
  })

  it('hearts はカード下部付近（top>=50%）から出現する', () => {
    const [minTop] = OVERLAY_EFFECT_PARTICLE_CONFIG.hearts.spawnTopPercentRange
    expect(minTop).toBeGreaterThanOrEqual(50)
  })

  it('各スタイルの range 設定は min <= max である', () => {
    for (const style of OVERLAY_EFFECT_STYLES) {
      const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style]
      expect(config.spawnLeftPercentRange[0]).toBeLessThanOrEqual(config.spawnLeftPercentRange[1])
      expect(config.spawnTopPercentRange[0]).toBeLessThanOrEqual(config.spawnTopPercentRange[1])
      expect(config.durationSecRange[0]).toBeLessThanOrEqual(config.durationSecRange[1])
      expect(config.delaySecRange[0]).toBeLessThanOrEqual(config.delaySecRange[1])
    }
  })
})

describe('overlay-effect: generateOverlayEffectParticles', () => {
  it('要求した個数ちょうどのパーティクルを返す（パーティクル数は変更しない）', () => {
    expect(OVERLAY_EFFECT_PARTICLE_COUNT).toBe(20)
    for (const style of OVERLAY_EFFECT_STYLES) {
      const particles = generateOverlayEffectParticles(style, OVERLAY_EFFECT_PARTICLE_COUNT)
      expect(particles).toHaveLength(20)
    }
  })

  it('各パーティクルのleft/top/animationDelay/animationDurationがスタイルの設定範囲内に収まる', () => {
    for (const style of OVERLAY_EFFECT_STYLES) {
      const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style]
      const particles = generateOverlayEffectParticles(style, 50)

      for (const particle of particles) {
        const left = Number.parseFloat(particle.left)
        const top = Number.parseFloat(particle.top)
        const delay = Number.parseFloat(particle.animationDelay)
        const duration = Number.parseFloat(particle.animationDuration)

        expect(particle.left.endsWith('%')).toBe(true)
        expect(particle.top.endsWith('%')).toBe(true)
        expect(particle.animationDelay.endsWith('s')).toBe(true)
        expect(particle.animationDuration.endsWith('s')).toBe(true)

        expect(left).toBeGreaterThanOrEqual(config.spawnLeftPercentRange[0])
        expect(left).toBeLessThanOrEqual(config.spawnLeftPercentRange[1])
        expect(top).toBeGreaterThanOrEqual(config.spawnTopPercentRange[0])
        expect(top).toBeLessThanOrEqual(config.spawnTopPercentRange[1])
        expect(delay).toBeGreaterThanOrEqual(config.delaySecRange[0])
        expect(delay).toBeLessThanOrEqual(config.delaySecRange[1])
        expect(duration).toBeGreaterThanOrEqual(config.durationSecRange[0])
        expect(duration).toBeLessThanOrEqual(config.durationSecRange[1])
      }
    }
  })

  it('各パーティクルの位置・タイミングはランダム化され、20個すべてが同一にはならない（機械的な動き防止）', () => {
    const particles = generateOverlayEffectParticles('hearts', OVERLAY_EFFECT_PARTICLE_COUNT)
    const uniqueLefts = new Set(particles.map((p) => p.left))
    const uniqueDurations = new Set(particles.map((p) => p.animationDuration))
    expect(uniqueLefts.size).toBeGreaterThan(1)
    expect(uniqueDurations.size).toBeGreaterThan(1)
  })
})
