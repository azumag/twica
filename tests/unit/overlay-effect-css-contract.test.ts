import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  ANIMATED_OVERLAY_EFFECT_STYLES,
  OVERLAY_EFFECT_PARTICLE_CONFIG,
  generateOverlayEffectParticles,
} from '@/lib/overlay-effect'

/**
 * overlay-effect.ts が inline style として出力する CSS カスタムプロパティ（--fx-*）は、
 * globals.css の @keyframes が var(--fx-*) で参照する「名前ベースの契約」。
 * TypeScript 側で変数名を変えても CSS 側は既定値へ無言でフォールバックするため、
 * 実際の CSS ファイルと突き合わせて退行を検出する。
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GLOBALS_CSS = readFileSync(join(REPO_ROOT, 'src/app/globals.css'), 'utf8')

/** `@keyframes overlay-effect-<style> { ... }` の中身を波かっこの対応を数えて抽出する */
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

/** キーフレーム内の `N% {` を列挙する（コメント中の % は除外する） */
function keyframeOffsets(style: string): number[] {
  const block = keyframesBlock(style).replace(/\/\*[\s\S]*?\*\//g, '')
  return [...block.matchAll(/(?:^|\n)\s*(\d+(?:\.\d+)?)%\s*\{/g)].map((match) => Number(match[1]))
}

/** `--animate-overlay-effect-<style>: ...;` の宣言値を取り出す */
function animateShorthand(style: string): string {
  const match = new RegExp(`--animate-overlay-effect-${style}:\\s*([^;]+);`).exec(GLOBALS_CSS)
  expect(match, `--animate-overlay-effect-${style} が globals.css にありません`).not.toBeNull()
  return match![1]
}

function referencedVars(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/var\(\s*(--fx-[a-z0-9-]+)/g)) names.add(match[1])
  return [...names].sort()
}

function emittedVars(style: (typeof ANIMATED_OVERLAY_EFFECT_STYLES)[number]): string[] {
  const names = new Set<string>()
  for (const particle of generateOverlayEffectParticles(style)) {
    for (const key of Object.keys(particle.visualStyle)) {
      if (key.startsWith('--fx-')) names.add(key)
    }
  }
  return [...names].sort()
}

describe('overlay-effect: globals.css との契約', () => {
  it.each(ANIMATED_OVERLAY_EFFECT_STYLES)(
    '%s が出力する --fx-* は対応する @keyframes の参照と一致する',
    (style) => {
      const block = keyframesBlock(style)
      // 片方向だけの比較だと、CSS 側だけが参照する変数の消失を見逃すため双方向で比較する
      expect(referencedVars(block)).toEqual(emittedVars(style))
      expect(emittedVars(style).length).toBeGreaterThan(0)
    },
  )

  it.each(ANIMATED_OVERLAY_EFFECT_STYLES)(
    '%s の animate-* は専用 keyframes を参照し infinite である',
    (style) => {
      const tokens = animateShorthand(style).trim().split(/\s+/)
      expect(tokens).toContain(`overlay-effect-${style}`)
      expect(tokens).toContain('infinite')
    },
  )

  it('各粒子スタイルは遅延中を透明にする fill-mode backwards を持つ', () => {
    for (const style of ANIMATED_OVERLAY_EFFECT_STYLES) {
      const tokens = animateShorthand(style).trim().split(/\s+/)
      expect(tokens).toContain('backwards')
    }
  })

  // 花火・シャボン玉・ハートは、timing-function を linear にしたうえで
  // 動きの形をキーフレームの中間ストップで作る。ease-* / cubic-bezier に戻すと
  // 各キーフレーム区間の末尾で速度が 0 に落ち、次の区間頭で再加速する退行になる。
  const LINEARIZED_STYLES = ['hearts', 'fireworks', 'bubbles'] as const

  it.each(LINEARIZED_STYLES)('%s の animate-* は linear タイミングである', (style) => {
    const tokens = animateShorthand(style).trim().split(/\s+/)
    expect(tokens).toContain('linear')
    expect(tokens.filter((token) => /^(?:ease(?:-in|-out|-in-out)?|cubic-bezier\()/.test(token))).toEqual([])
  })

  it.each(LINEARIZED_STYLES)('%s は区間ごとの停止を避けるため中間ストップを8点以上持つ', (style) => {
    const offsets = keyframeOffsets(style)
    expect(new Set(offsets).size).toBeGreaterThanOrEqual(8)
    expect(offsets).toContain(0)
    expect(offsets).toContain(100)
  })

  it('animationClassName は keyframes 名と1対1で対応する', () => {
    for (const style of ANIMATED_OVERLAY_EFFECT_STYLES) {
      expect(OVERLAY_EFFECT_PARTICLE_CONFIG[style].animationClassName).toBe(
        `animate-overlay-effect-${style}`,
      )
      // 参照先の keyframes が実在することまで確認する
      expect(keyframesBlock(style).length).toBeGreaterThan(0)
    }
  })
})
