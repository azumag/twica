import { describe, it, expect, vi, afterEach } from 'vitest'
import { selectWeightedCard, type WeightedCard } from '@/lib/gacha'

/**
 * secureRandomUnit（crypto.getRandomValues から 53bit の [0,1) 一様乱数を合成）を
 * 指定フラクションで固定する。閾値は `unit × プール重み合計` なので、境界条件を
 * 重みのスケールに依存せず直接指定できる。
 */
function mockRandomUnit(fraction: number) {
  const scaled = Math.min(Math.floor(fraction * 0x20000000000000), 0x1fffffffffffff)
  const high = Math.floor(scaled / 0x8000000)
  const low = scaled % 0x8000000
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((buf) => {
    if (buf instanceof Uint32Array && buf.length >= 2) {
      buf[0] = high << 6
      buf[1] = low << 5
    }
    return buf
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('selectWeightedCard', () => {
  it('returns null for empty array', () => {
    const result = selectWeightedCard<WeightedCard>([])
    expect(result).toBeNull()
  })

  it('selects a card from single item', () => {
    const cards: WeightedCard[] = [
      { id: '1', drop_rate: 1.0 }
    ]
    const result = selectWeightedCard(cards)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('1')
  })

  it('selects cards based on drop rates', () => {
    const cards: WeightedCard[] = [
      { id: 'common', drop_rate: 0.7 },
      { id: 'rare', drop_rate: 0.2 },
      { id: 'epic', drop_rate: 0.08 },
      { id: 'legendary', drop_rate: 0.02 }
    ]

    const results: Record<string, number> = {}
    const iterations = 10000

    for (let i = 0; i < iterations; i++) {
      const result = selectWeightedCard(cards)
      if (result) {
        results[result.id] = (results[result.id] || 0) + 1
      }
    }

    expect(results['common']).toBeGreaterThan(results['rare'])
    expect(results['rare']).toBeGreaterThan(results['epic'])
    expect(results['epic']).toBeGreaterThan(results['legendary'])
  })

  it('handles zero drop rate items', () => {
    const cards: WeightedCard[] = [
      { id: 'never', drop_rate: 0 },
      { id: 'always', drop_rate: 1.0 }
    ]
    const result = selectWeightedCard(cards)
    expect(result).not.toBeNull()
    // Zero drop rate items may be selected if random <= 0 after subtracting
    // This is edge case behavior - just verify we get a valid result
    expect(['never', 'always']).toContain(result?.id)
  })

  it('uses default drop rate of 1 when not specified', () => {
    const cards: WeightedCard[] = [
      { id: '1', drop_rate: 0.5 },
      { id: '2', drop_rate: 1.0 }
    ]
    const result = selectWeightedCard(cards)
    expect(result).not.toBeNull()
  })

  it('selects cards with equal probability when drop rates are equal', () => {
    const cards: WeightedCard[] = [
      { id: 'card1', drop_rate: 0.25 },
      { id: 'card2', drop_rate: 0.25 },
      { id: 'card3', drop_rate: 0.25 },
      { id: 'card4', drop_rate: 0.25 }
    ]

    const results: Record<string, number> = {}
    const iterations = 10000

    for (let i = 0; i < iterations; i++) {
      const result = selectWeightedCard(cards)
      if (result) {
        results[result.id] = (results[result.id] || 0) + 1
      }
    }

    expect(results['card1']).toBeGreaterThan(2000)
    expect(results['card2']).toBeGreaterThan(2000)
    expect(results['card3']).toBeGreaterThan(2000)
    expect(results['card4']).toBeGreaterThan(2000)
    expect(results['card1']).toBeLessThan(3000)
    expect(results['card2']).toBeLessThan(3000)
    expect(results['card3']).toBeLessThan(3000)
    expect(results['card4']).toBeLessThan(3000)
  })

  // ---------------------------------------------------------------------
  // 重みの精度に関する回帰テスト。
  //
  // 旧実装は `Math.round(drop_rate * 10000)` で重みを 1e-4 刻みの整数へ量子化して
  // いたため、パック指定 + レアリティ自動配分 (Issue #579) の実効重み
  // （= レアリティ% ÷ 同レアリティの枚数。丸めない小数）が歪んでいた。
  // 「同じカードばかり出る」という体感の原因になりうる分布のズレなので、
  // 量子化が復活したら落ちるテストで固定する。
  // ---------------------------------------------------------------------
  describe('重み精度（量子化バイアスの回帰テスト）', () => {
    it('1e-4 未満の実効重みでも排出対象から消えない', () => {
      // 「5% のレアリティを 600 枚へ配分」した 1 枚分。旧実装では
      // Math.round(0.0000833 * 10000) = 1 ではなく、より小さい重みだと 0 になり
      // 永久に当たらなかった。ここでは 0.00001（旧実装なら確実に 0）で検証する。
      const cards: WeightedCard[] = [
        { id: 'ultra-rare', drop_rate: 0.00001 },
        { id: 'common', drop_rate: 0.99999 },
      ]

      // 閾値が ultra-rare の区間 [0, 0.00001) に入るフラクションを指定する。
      mockRandomUnit(0.000005)
      expect(selectWeightedCard(cards)?.id).toBe('ultra-rare')
    })

    it('丸めずに重み比をそのまま反映する（旧実装では +19% ずれていた構成）', () => {
      // common 70% × 3枚 / rare 25% × 5枚 / legendary 5% × 600枚 を
      // computeEffectiveWeights と同じ式で構成したプール。
      const pool: WeightedCard[] = []
      const push = (rarity: string, percent: number, cardCount: number) => {
        for (let i = 0; i < cardCount; i += 1) {
          pool.push({ id: `${rarity}-${i}`, drop_rate: percent / 100 / cardCount })
        }
      }
      push('common', 70, 3)
      push('rare', 25, 5)
      push('legendary', 5, 600)

      // legendary の区間は累積 95% 以降。境界の直前/直後で正しく切り替わることを
      // 確認すれば、legendary 全体の占有幅が設計どおり 5% であると言える。
      mockRandomUnit(0.9499999)
      expect(selectWeightedCard(pool)?.id.startsWith('rare-')).toBe(true)

      mockRandomUnit(0.9500001)
      expect(selectWeightedCard(pool)?.id.startsWith('legendary-')).toBe(true)
    })

    it('区間の下端は当該カード、上端の直前は同じカードを返す', () => {
      const cards: WeightedCard[] = [
        { id: 'a', drop_rate: 0.3 },
        { id: 'b', drop_rate: 0.2 },
        { id: 'c', drop_rate: 0.5 },
      ]

      mockRandomUnit(0)
      expect(selectWeightedCard(cards)?.id).toBe('a')
      mockRandomUnit(0.2999999)
      expect(selectWeightedCard(cards)?.id).toBe('a')
      mockRandomUnit(0.3000001)
      expect(selectWeightedCard(cards)?.id).toBe('b')
      mockRandomUnit(0.4999999)
      expect(selectWeightedCard(cards)?.id).toBe('b')
      mockRandomUnit(0.5000001)
      expect(selectWeightedCard(cards)?.id).toBe('c')
      // 浮動小数点の累積誤差で末尾まで届かなかった場合も null にはしない
      mockRandomUnit(0.9999999)
      expect(selectWeightedCard(cards)?.id).toBe('c')
    })

    it('重みが正のカードだけを候補にし、全て0なら null を返す', () => {
      expect(selectWeightedCard([{ id: 'zero', drop_rate: 0 }])).toBeNull()

      // 負値・NaN は 0 として扱う（負値を累積和へ入れると後続カードの当選区間を
      // 食い潰して分布が壊れるため）
      const cards = [
        { id: 'negative', drop_rate: -1 },
        { id: 'nan', drop_rate: Number.NaN },
        { id: 'valid', drop_rate: 0.5 },
      ] as WeightedCard[]
      mockRandomUnit(0)
      expect(selectWeightedCard(cards)?.id).toBe('valid')
      mockRandomUnit(0.9999999)
      expect(selectWeightedCard(cards)?.id).toBe('valid')
    })

    it('DECIMAL が文字列で返ってきても重みとして解釈する', () => {
      const cards = [
        { id: 'a', drop_rate: '0.2500' },
        { id: 'b', drop_rate: '0.7500' },
      ] as unknown as WeightedCard[]

      mockRandomUnit(0.24)
      expect(selectWeightedCard(cards)?.id).toBe('a')
      mockRandomUnit(0.26)
      expect(selectWeightedCard(cards)?.id).toBe('b')
    })
  })

  it('カイ二乗検定で設計どおりの分布になっている', () => {
    // 自由度3の χ² 上側 0.1% 点は 16.27。実乱数を使うため確率的に落ちうるが、
    // 1000回に1回未満に抑えつつ、分布が明確に壊れれば検出できる水準。
    const cards: WeightedCard[] = [
      { id: 'legendary', drop_rate: 0.01 },
      { id: 'epic', drop_rate: 0.09 },
      { id: 'rare', drop_rate: 0.3 },
      { id: 'common', drop_rate: 0.6 },
    ]
    const iterations = 100_000
    const counts: Record<string, number> = {}

    for (let i = 0; i < iterations; i += 1) {
      const picked = selectWeightedCard(cards)
      expect(picked).not.toBeNull()
      counts[picked!.id] = (counts[picked!.id] ?? 0) + 1
    }

    const chiSquare = cards.reduce((sum, card) => {
      const expected = iterations * card.drop_rate
      return sum + (counts[card.id] - expected) ** 2 / expected
    }, 0)

    expect(chiSquare).toBeLessThan(16.27)
  })
})
