import { describe, it, expect, vi, afterEach } from 'vitest'
import { selectWeightedCard, type WeightedCard } from '@/lib/gacha'
import { mockSecureRandomUnit as mockRandomUnit } from '../utils/secure-random'

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
    // 重み 0 のカードは候補から除外される(`if (weight === 0) continue`)ため、
    // 乱数がどこへ落ちても構造的に選択され得ない。旧実装は累積和の比較次第で
    // 選ばれる余地があったため 'never' も許容していたが、現行は決定的。
    for (const fraction of [0, 0.5, 0.9999999]) {
      mockRandomUnit(fraction)
      expect(selectWeightedCard(cards)?.id).toBe('always')
    }
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
      // 乱数の上限 (1 - 2^-53) でも末尾カードの区間内に収まり null にならない
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

  it('生の乱数ビットが正しいスケールで [0,1) へ写像される', () => {
    // secureRandomUnit は非公開なので、抽選結果を通して写像を固定する。
    // χ²検定は確率的で、シフト量の取り違えのような中規模の劣化は見逃しうる
    // ため、写像そのものはフレーキー率ゼロの決定的テストで守る。
    //
    // 均等4枚なので各カードが unit の 0.25 幅の帯を受け持つ。どのカードが
    // 返るかで unit の値が一意に判別できる。
    const cards: WeightedCard[] = [
      { id: 'q1', drop_rate: 0.25 },
      { id: 'q2', drop_rate: 0.25 },
      { id: 'q3', drop_rate: 0.25 },
      { id: 'q4', drop_rate: 0.25 },
    ]
    const setRawBits = (high: number, low: number) => {
      vi.spyOn(crypto, 'getRandomValues').mockImplementation((buf) => {
        if (buf instanceof Uint32Array && buf.length >= 2) {
          buf[0] = high
          buf[1] = low
        }
        return buf
      })
    }

    // 全ビット0 → unit = 0 → 先頭の帯
    setRawBits(0x00000000, 0x00000000)
    expect(selectWeightedCard(cards)?.id).toBe('q1')

    // buf[0] = 0x40000000 → (>>> 6) = 2^24 → 2^24 × 2^27 / 2^53 = 0.25
    // シフト量を1つ誤る(>>> 5)と 0.5 になり q3 が返るため、取り違えを検出できる。
    setRawBits(0x40000000, 0x00000000)
    expect(selectWeightedCard(cards)?.id).toBe('q2')

    // buf[0] = 0x80000000 → (>>> 6) = 2^25 → 0.5。誤って >>> 5 にすると
    // unit = 1.0 となり区間を踏み外して q4 が返る。
    setRawBits(0x80000000, 0x00000000)
    expect(selectWeightedCard(cards)?.id).toBe('q3')

    // 全ビット1 → unit = 1 - 2^-53（1 未満）→ 末尾の帯に収まり、区間を
    // 超えて null になったりフォールバックへ落ちたりしない
    setRawBits(0xffffffff, 0xffffffff)
    expect(selectWeightedCard(cards)?.id).toBe('q4')
  })

  it('カイ二乗検定で設計どおりの分布になっている', () => {
    // 重みは「1e-4 の整数倍でない小さな値」を選ぶ。0.01/0.09/0.3/0.6 のような
    // キリのよい値は 1e-4 で量子化しても比が完全に保たれるため、旧実装の
    // 量子化バイアスをこの検定では検出できない（実測で確認済み）。ここでは
    // 「レアリティ枠を多数のカードへ薄く配分した」状況を模した重みを使い、
    // 量子化が復活すれば比が [0.2, 0.2, 0.2, 0.4] へ潰れて χ² が桁違いに
    // 跳ね上がる（旧実装での実測 χ² ≒ 7800）ようにする。
    const cards: WeightedCard[] = [
      { id: 'card-a', drop_rate: 0.000125 },
      { id: 'card-b', drop_rate: 0.000135 },
      { id: 'card-c', drop_rate: 0.000145 },
      { id: 'card-d', drop_rate: 0.000155 },
    ]
    const totalWeight = cards.reduce((sum, card) => sum + card.drop_rate, 0)
    const iterations = 100_000
    const counts: Record<string, number> = {}
    let nullCount = 0

    // ループ内で expect を呼ぶと assertion のオーバーヘッドが抽選本体の
    // 数倍になるため、null はカウンタで拾ってループ後に1回だけ検証する。
    for (let i = 0; i < iterations; i += 1) {
      const picked = selectWeightedCard(cards)
      if (!picked) {
        nullCount += 1
        continue
      }
      counts[picked.id] = (counts[picked.id] ?? 0) + 1
    }

    expect(nullCount).toBe(0)

    const chiSquare = cards.reduce((sum, card) => {
      const expected = (iterations * card.drop_rate) / totalWeight
      return sum + ((counts[card.id] ?? 0) - expected) ** 2 / expected
    }, 0)

    // 実乱数を使うため確率的に落ちうる。閾値は自由度3の χ² 上側 0.01% 点
    // 21.11 (P ≒ 9.99e-5 = 約1万回に1回) を採る。上側 0.1% 点の 16.27 でも
    // 検出力は足りるが、CI (test:agent) が --bail 1 で走るため1000回に1回の
    // 偽陽性でスイート全体が止まる。検出したい量子化回帰は χ² ≒ 7700 と
    // 桁が違うので、閾値を上げても検出力は実質落ちない。
    expect(chiSquare).toBeLessThan(21.11)
  })
})
