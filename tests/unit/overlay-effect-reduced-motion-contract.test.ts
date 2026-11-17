import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  ANIMATED_OVERLAY_EFFECT_STYLES,
  OVERLAY_EFFECT_PARTICLE_CONFIG,
} from '@/lib/overlay-effect'

/**
 * prefers-reduced-motion 環境では、overlay エフェクトは「動きを止めつつ
 * 見える状態を保つ」方針（Issue #2066 で DSH が推奨・採用された (a)）。
 * globals.css の @media (prefers-reduced-motion: reduce) ブロックが、
 * aura 以外の9スタイルに animation: none + 静的な不透明 opacity を
 * 与えることを、実際の CSS ファイルと突き合わせて担保する。
 *
 * 以前の 2 秒同期フェード（overlay-effect-reduced-fade）は周期の端で
 * 全粒子が同時に透明になる（≒2秒周期の明滅）ため廃止された。その退行
 * （フェードへの回帰や opacity: 0 の静置）をこの契約テストで検出する。
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GLOBALS_CSS = readFileSync(join(REPO_ROOT, 'src/app/globals.css'), 'utf8')

/** `@media (prefers-reduced-motion: reduce) { ... }` の中身を抽出する */
function reducedMotionBlock(): string {
  const header = '@media (prefers-reduced-motion: reduce)'
  const headerIndex = GLOBALS_CSS.indexOf(header)
  expect(headerIndex).toBeGreaterThanOrEqual(0)
  const start = GLOBALS_CSS.indexOf('{', headerIndex)
  let depth = 0
  for (let index = start; index < GLOBALS_CSS.length; index += 1) {
    if (GLOBALS_CSS[index] === '{') depth += 1
    else if (GLOBALS_CSS[index] === '}') {
      depth -= 1
      if (depth === 0) return GLOBALS_CSS.slice(start, index + 1)
    }
  }
  throw new Error('@media (prefers-reduced-motion: reduce) が閉じていません')
}

/** `@keyframes overlay-effect-<style> { ... }` の中身を抽出する */
function keyframesBlock(style: string): string {
  const header = `@keyframes overlay-effect-${style} {`
  const headerIndex = GLOBALS_CSS.indexOf(header)
  expect(headerIndex).toBeGreaterThanOrEqual(0)
  const start = headerIndex + header.length - 1
  let depth = 0
  for (let index = start; index < GLOBALS_CSS.length; index += 1) {
    if (GLOBALS_CSS[index] === '{') depth += 1
    else if (GLOBALS_CSS[index] === '}') {
      depth -= 1
      if (depth === 0) return GLOBALS_CSS.slice(start, index + 1)
    }
  }
  throw new Error(`@keyframes overlay-effect-${style} が閉じていません`)
}

/**
 * media query ブロック内で `.animate-overlay-effect-<style>` を含む
 * セレクタの宣言部を返す。複数クラスをまとめたセレクタ（a, b { ... }）も
 * 対象にするため、ブロックをルール単位に分解してからクラス名を探す。
 */
function reducedMotionDeclarations(style: string): string {
  const block = reducedMotionBlock()
  const className = `.animate-overlay-effect-${style}`
  // CSS コメントを除去してからルールを走査する
  const stripped = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of stripped.matchAll(rulePattern)) {
    const selectors = match[1].split(',').map((selector) => selector.trim())
    if (selectors.includes(className)) return match[2]
  }
  throw new Error(`${className} が reduced-motion ブロックにありません`)
}

function declarationsOf(style: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const declaration of reducedMotionDeclarations(style).split(';')) {
    const separator = declaration.indexOf(':')
    if (separator <= 0) continue
    result[declaration.slice(0, separator).trim()] = declaration
      .slice(separator + 1)
      .trim()
  }
  return result
}

/**
 * キーフレームが取る opacity のピーク値。数値リテラルなら最大値。
 * snow のようにピークが per-particle の var() 参照の場合はその式を返す
 * （静的指定は同じ var() 参照で揃える契約）。
 */
function peakOpacity(style: string): string {
  const block = keyframesBlock(style)
  const values = [...block.matchAll(/opacity:\s*([^;]+);/g)].map((m) => m[1].trim())
  expect(values.length).toBeGreaterThan(0)
  const variable = values.find((value) => value.startsWith('var('))
  if (variable) return variable
  return Math.max(...values.map(Number)).toString()
}

/** aura 以外の9スタイル（reduced-motion で静止表示する対象） */
const STATIC_STYLES = ANIMATED_OVERLAY_EFFECT_STYLES.filter(
  (style) => style !== 'aura',
)

describe('overlay-effect: reduced-motion 契約（Issue #2066 方針(a)）', () => {
  it('9スタイルが全て reduced-motion ブロックで対象になっている', () => {
    // 方針の対象漏れ（スタイル追加時の置き忘れ）を検出する
    expect(STATIC_STYLES).toEqual([
      'sparkle',
      'confetti',
      'hearts',
      'fireworks',
      'stars',
      'bubbles',
      'petals',
      'snow',
      'coins',
    ])
    for (const style of STATIC_STYLES) {
      expect(
        OVERLAY_EFFECT_PARTICLE_CONFIG[style].animationClassName,
      ).toBe(`animate-overlay-effect-${style}`)
      expect(() => reducedMotionDeclarations(style)).not.toThrow()
    }
  })

  it.each(STATIC_STYLES)(
    '%s は animation: none と静的な不透明 opacity を持つ',
    (style) => {
      const declarations = declarationsOf(style)
      expect(declarations.animation).toMatch(/^none(\s+!important)?$/)
      // 静止 opacity は各キーフレームのピーク値に固定される（> 0 が本質。
      // ピーク値との一致で「opacity: 0 への退行」と「低すぎる固定値」の両方を防ぐ）
      expect(declarations.opacity).toBe(peakOpacity(style))
    },
  )

  it('aura は従来の静的表示（animation: none + transform: none + opacity 0.55）を維持する', () => {
    const declarations = declarationsOf('aura')
    expect(declarations.animation).toMatch(/^none(\s+!important)?$/)
    expect(declarations.transform).toBe('none')
    expect(declarations.opacity).toBe('0.55')
  })

  it('2秒同期フェード overlay-effect-reduced-fade は廃止されている', () => {
    // keyframes 定義・参照のどちらも残さない（周期端の全粒子透明 = strongMin 0 の原因）
    // コメント中の言及は実コードではないため、コメントを除去してから検査する
    const code = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toContain('overlay-effect-reduced-fade')
  })

  it('reduced-motion ブロック内で明滅するアニメーションを再導入しない', () => {
    // infinite な opacity 変化は「約 N 秒周期の明滅」として reduced-motion の
    // 趣旨に反するため、ブロック内の animation は全て none であることを担保する
    const block = reducedMotionBlock().replace(/\/\*[\s\S]*?\*\//g, '')
    const animations = [...block.matchAll(/animation:\s*([^;]+);/g)].map((m) =>
      m[1].trim(),
    )
    expect(animations.length).toBeGreaterThan(0)
    for (const animation of animations) {
      expect(animation).toMatch(/^none(\s+!important)?$/)
    }
  })
})
