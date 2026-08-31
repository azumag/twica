import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  selectWeightedCardMinimizingRepeat,
  type WeightedCard,
} from '@/lib/gacha'
import { mockSecureRandomUnit } from '../utils/secure-random'

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * crypto.getRandomValues を決定的な xorshift32 列へ差し替える。
 * 統計テストを毎回同じ結果にし、確率的なフレーキーを避ける。
 */
function mockDeterministicCrypto(seed = 0x12345678) {
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

describe('selectWeightedCardMinimizingRepeat', () => {
  it('直前カードが未指定または現プールに無い場合は従来の独立抽選へ戻る', () => {
    const cards: WeightedCard[] = [
      { id: 'a', drop_rate: 0.25 },
      { id: 'b', drop_rate: 0.75 },
    ]

    const firstRandom = mockSecureRandomUnit(0.1)
    expect(selectWeightedCardMinimizingRepeat(cards, null)?.id).toBe('a')

    firstRandom.mockRestore()
    mockSecureRandomUnit(0.8)
    expect(selectWeightedCardMinimizingRepeat(cards, 'missing')?.id).toBe('b')
  })

  it('空・全重み0・1枚だけのプールを安全に処理する', () => {
    expect(selectWeightedCardMinimizingRepeat([], 'a')).toBeNull()
    expect(selectWeightedCardMinimizingRepeat([
      { id: 'a', drop_rate: 0 },
      { id: 'b', drop_rate: -1 },
    ], 'a')).toBeNull()

    const only = { id: 'only', drop_rate: 1 }
    expect(selectWeightedCardMinimizingRepeat([only], 'only')).toBe(only)
  })

  it('最大重みが50%以下なら、どの直前カードからも即時反復しない', () => {
    const cards: WeightedCard[] = [
      { id: 'a', drop_rate: 0.4 },
      { id: 'b', drop_rate: 0.3 },
      { id: 'c', drop_rate: 0.2 },
      { id: 'd', drop_rate: 0.1 },
    ]
    mockDeterministicCrypto()

    let nullCount = 0
    let repeatCount = 0
    for (const previous of cards) {
      for (let sample = 0; sample < 1_000; sample += 1) {
        const picked = selectWeightedCardMinimizingRepeat(cards, previous.id)
        if (!picked) {
          nullCount += 1
        } else if (picked.id === previous.id) {
          repeatCount += 1
        }
      }
    }

    expect(nullCount).toBe(0)
    expect(repeatCount).toBe(0)
  })

  it('均等4枚でも固定の2周期へ閉じず、全カードへ遷移する', () => {
    const cards: WeightedCard[] = [
      { id: 'a', drop_rate: 0.25 },
      { id: 'b', drop_rate: 0.25 },
      { id: 'c', drop_rate: 0.25 },
      { id: 'd', drop_rate: 0.25 },
    ]
    mockDeterministicCrypto()

    let previousId = 'a'
    let nullCount = 0
    let repeatCount = 0
    const seen = new Set([previousId])
    for (let draw = 0; draw < 1_000; draw += 1) {
      const picked = selectWeightedCardMinimizingRepeat(cards, previousId)
      if (!picked) {
        nullCount += 1
        continue
      }
      if (picked.id === previousId) repeatCount += 1
      previousId = picked.id
      seen.add(previousId)
    }

    expect(nullCount).toBe(0)
    expect(repeatCount).toBe(0)
    expect(seen).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('過半カードがある場合も設定分布を維持し、反復率を理論下限まで下げる', () => {
    const cards: WeightedCard[] = [
      { id: 'a', drop_rate: 0.6 },
      { id: 'b', drop_rate: 0.2 },
      { id: 'c', drop_rate: 0.2 },
    ]
    mockDeterministicCrypto(0x9e3779b9)

    const counts = new Map(cards.map((card) => [card.id, 0]))
    let previousId = 'a'
    let nullCount = 0
    let repeatCount = 0
    const iterations = 100_000

    for (let draw = 0; draw < iterations; draw += 1) {
      const picked = selectWeightedCardMinimizingRepeat(cards, previousId)
      if (!picked) {
        nullCount += 1
        continue
      }

      counts.set(picked.id, (counts.get(picked.id) ?? 0) + 1)
      if (picked.id === previousId) repeatCount += 1
      previousId = picked.id
    }

    expect(nullCount).toBe(0)
    expect((counts.get('a') ?? 0) / iterations).toBeCloseTo(0.6, 2)
    expect((counts.get('b') ?? 0) / iterations).toBeCloseTo(0.2, 2)
    expect((counts.get('c') ?? 0) / iterations).toBeCloseTo(0.2, 2)

    // p_max=0.6 なので、排出率を維持したまま達成できる最小反復率は
    // 2 * 0.6 - 1 = 0.2。独立抽選の反復率 0.6²+0.2²+0.2²=0.44 から半減する。
    expect(repeatCount / iterations).toBeCloseTo(0.2, 2)
  })

  it('DB行順が変わってもカードID順の同じ遷移になる', () => {
    const cards: WeightedCard[] = [
      { id: 'a', drop_rate: 0.4 },
      { id: 'b', drop_rate: 0.35 },
      { id: 'c', drop_rate: 0.25 },
    ]

    mockDeterministicCrypto(0xabcdef01)
    const ordered = selectWeightedCardMinimizingRepeat(cards, 'b')

    vi.restoreAllMocks()
    mockDeterministicCrypto(0xabcdef01)
    const shuffled = selectWeightedCardMinimizingRepeat(
      [cards[2], cards[0], cards[1]],
      'b',
    )

    expect(shuffled?.id).toBe(ordered?.id)
  })

  it('DECIMALが文字列で返るfixtureでも重みとして扱う', () => {
    const cards = [
      { id: 'a', drop_rate: '0.4000' },
      { id: 'b', drop_rate: '0.3500' },
      { id: 'c', drop_rate: '0.2500' },
    ] as unknown as WeightedCard[]
    mockDeterministicCrypto()

    const picked = selectWeightedCardMinimizingRepeat(cards, 'a')
    expect(picked).not.toBeNull()
    expect(picked?.id).not.toBe('a')
  })
})
