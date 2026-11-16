import { describe, it, expect } from 'vitest'
import {
  DEFAULT_OVERLAY_EFFECT_STYLE,
  OVERLAY_EFFECT_STYLES,
  ANIMATED_OVERLAY_EFFECT_STYLES,
  OVERLAY_EFFECT_PARTICLE_CONFIG,
  DEFAULT_BUILTIN_RARITY_EFFECTS,
  DEFAULT_RARITY_EFFECT_MAP,
  normalizeOverlayEffectStyle,
  isOverlayEffectStyle,
  generateOverlayEffectParticles,
  resolveEffectForRarity,
  serializeRarityEffectMap,
  parseRarityEffectMap,
} from '@/lib/overlay-effect'

/**
 * 「表示開始時点で周期の途中にいる」負の delay を使う環境系スタイル。
 * fireworks（バースト同期）と aura（元から負の delay の光輪）は対象外。
 */
const PHASE_ALIGNED_STYLES = [
  'sparkle',
  'confetti',
  'hearts',
  'stars',
  'bubbles',
  'petals',
  'snow',
  'coins',
] as const

describe('overlay-effect: normalizeOverlayEffectStyle', () => {
  it('既知のスタイル文字列はそのまま返す', () => {
    for (const style of OVERLAY_EFFECT_STYLES) {
      expect(normalizeOverlayEffectStyle(style)).toBe(style)
    }
  })

  it('"none" も正規の値として受理する', () => {
    expect(normalizeOverlayEffectStyle('none')).toBe('none')
    expect(isOverlayEffectStyle('none')).toBe(true)
  })

  it('未知文字列はデフォルト(sparkle)に丸める', () => {
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

  it('種類が増えている（sparkle/confetti/hearts に加え新演出がある）', () => {
    // 品質改善で種類を増やしたことの回帰防止
    for (const style of ['sparkle', 'confetti', 'hearts', 'fireworks', 'stars', 'bubbles', 'petals', 'snow', 'coins', 'aura', 'none']) {
      expect(OVERLAY_EFFECT_STYLES).toContain(style)
    }
  })
})

describe('overlay-effect: OVERLAY_EFFECT_PARTICLE_CONFIG', () => {
  it('"none" を除く全スタイル分の設定が存在する', () => {
    for (const style of ANIMATED_OVERLAY_EFFECT_STYLES) {
      expect(OVERLAY_EFFECT_PARTICLE_CONFIG[style]).toBeDefined()
    }
  })

  it('各スタイルは固有のアニメーションクラス（overlay-effect-<style>）を持ち、互いに重複しない', () => {
    const classNames = ANIMATED_OVERLAY_EFFECT_STYLES.map(
      (style) => OVERLAY_EFFECT_PARTICLE_CONFIG[style].animationClassName,
    )
    // 全て一意（旧バグ: confetti/hearts が同じ animate-bounce を共有していた）の再発防止
    expect(new Set(classNames).size).toBe(classNames.length)
    for (const className of classNames) {
      expect(className).toMatch(/^animate-overlay-effect-/)
      expect(className).not.toBe('animate-bounce')
    }
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

  it('各スタイルの range 設定は min <= max、particleCount は正の数である', () => {
    for (const style of ANIMATED_OVERLAY_EFFECT_STYLES) {
      const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style]
      expect(config.spawnLeftPercentRange[0]).toBeLessThanOrEqual(config.spawnLeftPercentRange[1])
      expect(config.spawnTopPercentRange[0]).toBeLessThanOrEqual(config.spawnTopPercentRange[1])
      expect(config.durationSecRange[0]).toBeLessThanOrEqual(config.durationSecRange[1])
      // delaySecRange は「正の delay を使うスタイル」だけが持つ任意項目
      // （aura は負の delay のみなので範囲も負側になる）
      if (config.delaySecRange) {
        expect(config.delaySecRange[0]).toBeLessThanOrEqual(config.delaySecRange[1])
      }
      expect(config.particleCount).toBeGreaterThan(0)
    }
  })

  it('環境系8種は startAtRandomPhase、fireworks/aura は正の delay 範囲を持つ', () => {
    for (const style of PHASE_ALIGNED_STYLES) {
      const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style]
      expect(config.startAtRandomPhase).toBe(true)
      // 負の delay を算出するため、正の delay 範囲は持たない（設定の二重管理を防ぐ）
      expect(config.delaySecRange).toBeUndefined()
    }
    for (const style of ['fireworks', 'aura'] as const) {
      const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style]
      expect(config.startAtRandomPhase).toBeFalsy()
      expect(config.delaySecRange).toBeDefined()
    }
  })
})

describe('overlay-effect: generateOverlayEffectParticles', () => {
  it('"none" は空配列を返す（演出なし）', () => {
    expect(generateOverlayEffectParticles('none')).toEqual([])
  })

  it('各スタイルの particleCount 個ちょうどを返す', () => {
    for (const style of ANIMATED_OVERLAY_EFFECT_STYLES) {
      const particles = generateOverlayEffectParticles(style)
      expect(particles).toHaveLength(OVERLAY_EFFECT_PARTICLE_CONFIG[style].particleCount)
    }
  })

  it('各パーティクルの left/top/animationDuration がスタイルの設定範囲内に収まる', () => {
    for (const style of ANIMATED_OVERLAY_EFFECT_STYLES) {
      const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style]
      const particles = generateOverlayEffectParticles(style)

      for (const particle of particles) {
        const left = Number.parseFloat(particle.left)
        const top = Number.parseFloat(particle.top)
        const duration = Number.parseFloat(particle.animationDuration)

        expect(particle.left.endsWith('%')).toBe(true)
        expect(particle.top.endsWith('%')).toBe(true)
        expect(particle.animationDuration.endsWith('s')).toBe(true)

        expect(left).toBeGreaterThanOrEqual(config.spawnLeftPercentRange[0])
        expect(left).toBeLessThanOrEqual(config.spawnLeftPercentRange[1])
        expect(top).toBeGreaterThanOrEqual(config.spawnTopPercentRange[0])
        expect(top).toBeLessThanOrEqual(config.spawnTopPercentRange[1])
        expect(duration).toBeGreaterThanOrEqual(config.durationSecRange[0])
        expect(duration).toBeLessThanOrEqual(config.durationSecRange[1])
      }
    }
  })

  it('環境系8種は delay が必ず [-duration, 0] に入る（表示開始時点で周期の途中）', () => {
    for (const style of PHASE_ALIGNED_STYLES) {
      const particles = generateOverlayEffectParticles(style)
      expect(particles.length).toBeGreaterThan(0)

      for (const particle of particles) {
        const delay = Number.parseFloat(particle.animationDelay)
        const duration = Number.parseFloat(particle.animationDuration)

        expect(particle.animationDelay.endsWith('s')).toBe(true)
        expect(duration).toBeGreaterThan(0)
        // 負の delay。0 は「周期の先頭」なので許容するが、正にはしない。
        expect(delay).toBeLessThanOrEqual(0)
        // 絶対値が 1 周期を超えると 2 周目に入り、開始位相の意図が崩れる
        expect(delay).toBeGreaterThanOrEqual(-duration)
      }

      // 全粒子が同じ位相だと同期して見えるため、位相がばらけていることも確認する
      const uniqueDelays = new Set(particles.map((p) => p.animationDelay))
      expect(uniqueDelays.size).toBeGreaterThan(1)
    }
  })

  it('fireworks/aura の delay は宣言した delaySecRange に入る', () => {
    for (const style of ['fireworks', 'aura'] as const) {
      const config = OVERLAY_EFFECT_PARTICLE_CONFIG[style]
      expect(config.delaySecRange).toBeDefined()
      const range = config.delaySecRange
      if (!range) throw new Error(`${style} の delaySecRange が未設定`)
      const [minDelay, maxDelay] = range
      for (const particle of generateOverlayEffectParticles(style)) {
        const delay = Number.parseFloat(particle.animationDelay)
        expect(particle.animationDelay.endsWith('s')).toBe(true)
        expect(delay).toBeGreaterThanOrEqual(minDelay)
        expect(delay).toBeLessThanOrEqual(maxDelay)
      }
    }
  })

  it('fireworks の火花はバースト内で delay と duration を共有する', () => {
    const particles = generateOverlayEffectParticles('fireworks')
    const sparksPerBurst = 12
    const bursts = new Map<number, { delay: string; duration: string }[]>()
    for (let index = 0; index < particles.length; index += 1) {
      const burstIndex = Math.floor(index / sparksPerBurst)
      const entry = {
        delay: particles[index].animationDelay,
        duration: particles[index].animationDuration,
      }
      const list = bursts.get(burstIndex)
      if (list) list.push(entry)
      else bursts.set(burstIndex, [entry])
    }

    expect(bursts.size).toBe(4)
    for (const sparks of bursts.values()) {
      expect(sparks).toHaveLength(sparksPerBurst)
      expect(new Set(sparks.map((s) => s.delay)).size).toBe(1)
      expect(new Set(sparks.map((s) => s.duration)).size).toBe(1)
    }

    // バースト間では開始時刻がずれる（全バーストが同時に破裂しない）
    const burstDelays = [...bursts.values()].map((sparks) => Number.parseFloat(sparks[0].delay))
    expect(new Set(burstDelays).size).toBe(bursts.size)
    const burstDurations = [...bursts.values()].map((sparks) => Number.parseFloat(sparks[0].duration))
    // 周期は全バーストで共通。バーストごとに変えると位相がずれ、全バーストが
    // 同時に暗転して火花が消える時間帯が周期的に生まれる（実測で確認済み）。
    expect(new Set(burstDurations).size).toBe(1)
    // 開始時刻は周期をバースト数で等分した間隔（暗い区間 12% より広い）で並ぶ。
    // これにより「少なくとも1バーストは明るい」状態が保たれる。
    const period = burstDurations[0]
    expect(period).toBeGreaterThan(0)
    for (let index = 1; index < burstDelays.length; index += 1) {
      expect(burstDelays[index] - burstDelays[index - 1]).toBeCloseTo(period / bursts.size, 2)
      // 1バーストの暗転は周期の約12%。間隔がそれより広いことを保証する
      expect(burstDelays[index] - burstDelays[index - 1]).toBeGreaterThan(period * 0.12)
    }
  })

  it('各パーティクルは見た目情報（content と visualStyle）を持つ', () => {
    const particles = generateOverlayEffectParticles('confetti')
    for (const particle of particles) {
      expect(typeof particle.content).toBe('string')
      expect(particle.visualStyle).toBeTypeOf('object')
      // 品質向上の核: パーティクル毎に固有の軌道 CSS 変数が付与される
      expect(Object.keys(particle.visualStyle).some((key) => key.startsWith('--fx-'))).toBe(true)
    }
  })

  it('fireworks は少数の共通バースト中心から破裂する（散発的な独立点にならない）', () => {
    const particles = generateOverlayEffectParticles('fireworks')
    // 同じバーストの火花は開始タイミング（animationDelay）を共有し、
    // 演出全体では数個の遅延バンド（=バースト）にまとまる。パーティクル数（48）
    // より遥かに少ないバンド数であることを確認する。
    const delayBands = new Set(
      particles.map((p) => Math.round(Number.parseFloat(p.animationDelay) / 0.55)),
    )
    expect(delayBands.size).toBeLessThanOrEqual(5)
    expect(delayBands.size).toBeLessThan(particles.length)
    // それでも火花ごとの放射方向（--fx-dx）は個別化されている
    const uniqueDx = new Set(particles.map((p) => p.visualStyle['--fx-dx']))
    expect(uniqueDx.size).toBeGreaterThan(1)
  })

  it('hearts は ♥ グリフを表示する', () => {
    const particles = generateOverlayEffectParticles('hearts')
    for (const particle of particles) {
      expect(particle.content).toBe('♥')
    }
  })

  it('aura は少数の相対サイズ光輪を生成し、縮小表示でもカードの大きさに追従する', () => {
    const particles = generateOverlayEffectParticles('aura')
    expect(particles).toHaveLength(3)
    for (const particle of particles) {
      expect(particle.content).toBe('')
      expect(particle.visualStyle.width).toMatch(/^\d+(\.\d+)?%$/)
      expect(particle.visualStyle.height).toMatch(/^\d+(\.\d+)?%$/)
      expect(particle.visualStyle.borderRadius).toBe('50%')
    }
  })

  it('各パーティクルの位置・タイミング・色はランダム化され、全てが同一にはならない（機械的な動き防止）', () => {
    const particles = generateOverlayEffectParticles('confetti')
    const uniqueLefts = new Set(particles.map((p) => p.left))
    const uniqueDurations = new Set(particles.map((p) => p.animationDuration))
    const uniqueColors = new Set(particles.map((p) => p.visualStyle.backgroundColor))
    expect(uniqueLefts.size).toBeGreaterThan(1)
    expect(uniqueDurations.size).toBeGreaterThan(1)
    expect(uniqueColors.size).toBeGreaterThan(1)
  })
})

describe('overlay-effect: レアリティ別マップ', () => {
  it('既定はレジェンダリーのみ sparkle、他は演出なし（従来挙動の非破壊維持）', () => {
    expect(DEFAULT_BUILTIN_RARITY_EFFECTS).toEqual({
      common: 'none',
      rare: 'none',
      epic: 'none',
      legendary: 'sparkle',
    })
    expect(DEFAULT_RARITY_EFFECT_MAP).toEqual({ legendary: 'sparkle' })
  })

  it('resolveEffectForRarity: マップに無いレアリティ（カスタム含む）は "none"', () => {
    const map = { legendary: 'fireworks' as const, epic: 'confetti' as const }
    expect(resolveEffectForRarity(map, 'legendary')).toBe('fireworks')
    expect(resolveEffectForRarity(map, 'epic')).toBe('confetti')
    expect(resolveEffectForRarity(map, 'common')).toBe('none')
    expect(resolveEffectForRarity(map, 'mythic')).toBe('none')
  })

  it('serialize/deserialize（parse）が往復する', () => {
    const map = { epic: 'confetti' as const, legendary: 'fireworks' as const }
    const serialized = serializeRarityEffectMap(map)
    expect(serialized).toBe('epic:confetti,legendary:fireworks')
    // fx= 経由で戻すと、none のレアリティは省略された同値マップになる
    expect(parseRarityEffectMap(serialized, null)).toEqual(map)
  })

  it('serialize: 全て none のとき "off" を返し、parse で空マップに戻る', () => {
    const allNone = { common: 'none' as const, rare: 'none' as const, epic: 'none' as const, legendary: 'none' as const }
    expect(serializeRarityEffectMap(allNone)).toBe('off')
    expect(parseRarityEffectMap('off', null)).toEqual({})
  })

  it('parse: fx が無く effect（レガシー）がある場合は legendary 専用として解釈する（後方互換）', () => {
    expect(parseRarityEffectMap(null, 'confetti')).toEqual({ legendary: 'confetti' })
    // 未知のレガシー値は sparkle に丸める
    expect(parseRarityEffectMap(null, 'unknown')).toEqual({ legendary: 'sparkle' })
  })

  it('parse: fx も effect も無ければ既定（legendary: sparkle）', () => {
    expect(parseRarityEffectMap(null, null)).toEqual({ legendary: 'sparkle' })
  })

  it('parse: fx が優先され、レガシー effect は無視される', () => {
    expect(parseRarityEffectMap('epic:hearts', 'confetti')).toEqual({ epic: 'hearts' })
  })

  it('aura は fx の往復とレガシー effect の両方で扱え、fx が優先される', () => {
    const map = { epic: 'aura' as const, legendary: 'sparkle' as const }
    expect(parseRarityEffectMap(serializeRarityEffectMap(map), 'hearts')).toEqual(map)
    expect(resolveEffectForRarity(map, 'epic')).toBe('aura')
    expect(parseRarityEffectMap(null, 'aura')).toEqual({ legendary: 'aura' })
  })

  it('parse: 不正なペア（未知スタイル・空レアリティ名）はスキップする', () => {
    // legendary:bogus は未知スタイルなのでスキップ、epic:snow のみ残る
    expect(parseRarityEffectMap('legendary:bogus,epic:snow,:hearts', null)).toEqual({ epic: 'snow' })
  })

  it('serialize/deserialize: レアリティ名に区切り文字（, や :）を含んでも往復できる', () => {
    // カスタムレアリティ名が "," や ":" を含んでいても serialize/deserialize で
    // 壊れないことを確認する（レビュー指摘: 区切り文字のエスケープ漏れ）
    const map = { 'boss,rare': 'fireworks' as const, 'a:b': 'confetti' as const }
    const serialized = serializeRarityEffectMap(map)
    expect(parseRarityEffectMap(serialized, null)).toEqual(map)
  })

  it('parse: 手書きの fx= でレアリティ名を encodeURIComponent すれば区切り文字を含めて指定できる', () => {
    // アプリが生成する fx= はレアリティ名を encodeURIComponent するため、
    // 手書きする場合も同様にエンコードすれば区切り文字を含むカスタム
    // レアリティ名を安全に指定できることを確認する
    expect(parseRarityEffectMap('boss%2Crare:fireworks', null)).toEqual({ 'boss,rare': 'fireworks' })
  })
})
