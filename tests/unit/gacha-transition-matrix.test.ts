import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  selectWeightedCardMinimizingRepeat,
  type WeightedCard,
} from '@/lib/gacha'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * crypto.getRandomValues を決定的な xorshift32 列へ差し替える。
 * 統計テストを毎回同じ結果にし、確率的なフレーキーを避ける。
 */
function mockDeterministicCrypto(seed = 0x9e3779b9) {
  let state = seed >>> 0
  const nextUint32 = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }

  return vi.spyOn(crypto, 'getRandomValues').mockImplementation((buf) => {
    if (buf instanceof Uint32Array && buf.length >= 2) {
      buf[0] = nextUint32()
      buf[1] = nextUint32()
    }
    return buf
  })
}

const EQUAL_FOUR: WeightedCard[] = [
  { id: 'a', drop_rate: 1 },
  { id: 'b', drop_rate: 1 },
  { id: 'c', drop_rate: 1 },
  { id: 'd', drop_rate: 1 },
]

/**
 * Issue #1302: 均等4枚プールの条件付き遷移行列を実測し、判断根拠として固定する。
 *
 * 現行方式は長期の周辺分布と即時反復率の理論下限を保証するが、
 * `次カード | 直前カード` の条件付き分布が一様になることは保証しない。
 * docs/gacha-repeat-protection-correlation.md に記載のとおり、
 * 直前カードから見た遷移は ID 順に回転した `0 / 25% / 50% / 25%` になる。
 *
 * このテストはその行列を決定的乱数で実測し、仕様として回帰固定する。
 * 将来、最大エントロピー結合などの平準化方式へ変える場合は、
 * この行列が変わることをもって変更の検出とする。
 */
describe('selectWeightedCardMinimizingRepeat transition matrix (issue #1302)', () => {
  it('均等4枚の条件付き遷移は 0 / 25% / 50% / 25% の回転形になる', () => {
    const ids = EQUAL_FOUR.map((card) => card.id)
    const drawsPerSource = 20000
    const tolerance = 0.02

    ids.forEach((sourceId, sourceIndex) => {
      mockDeterministicCrypto(0x9e3779b9 + sourceIndex)
      const counts = new Map<string, number>()
      for (let i = 0; i < drawsPerSource; i++) {
        const next = selectWeightedCardMinimizingRepeat(EQUAL_FOUR, sourceId)
        counts.set(next!.id, (counts.get(next!.id) ?? 0) + 1)
      }
      vi.restoreAllMocks()

      ids.forEach((targetId, targetIndex) => {
        const offset = (targetIndex - sourceIndex + ids.length) % ids.length
        const expected = offset === 0 ? 0 : offset === 2 ? 0.5 : 0.25
        const actual = (counts.get(targetId) ?? 0) / drawsPerSource
        expect(
          Math.abs(actual - expected),
          `P(${targetId} | ${sourceId}) = ${actual}, expected ${expected}`,
        ).toBeLessThan(tolerance)
      })
    })
  })

  it('条件付き相関があっても長期チェーンの周辺分布は設定重みどおりに保たれる', () => {
    mockDeterministicCrypto(0x51ed270b)
    const counts = new Map<string, number>()
    let previous: string | null = 'a'
    const steps = 100000
    for (let i = 0; i < steps; i++) {
      const next: WeightedCard | null = selectWeightedCardMinimizingRepeat(EQUAL_FOUR, previous)
      counts.set(next!.id, (counts.get(next!.id) ?? 0) + 1)
      previous = next!.id
    }

    for (const card of EQUAL_FOUR) {
      const actual = (counts.get(card.id) ?? 0) / steps
      expect(
        Math.abs(actual - 0.25),
        `stationary P(${card.id}) = ${actual}, expected 0.25`,
      ).toBeLessThan(0.01)
    }
  })
})
