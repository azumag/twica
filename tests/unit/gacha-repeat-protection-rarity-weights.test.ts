import { afterEach, describe, expect, it, vi } from 'vitest'
import { GachaService } from '@/lib/services/gacha'
import { mockSecureRandomUnit } from '../utils/secure-random'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GachaService repeat protection with rarity weights', () => {
  it('実効レアリティ重みを使って反復を抑制し、返却値は元のdrop_rateを維持する', () => {
    mockSecureRandomUnit(0)

    const pool = [
      {
        id: 'card-a',
        name: 'Card A',
        description: null,
        image_url: null,
        rarity: 'common' as const,
        drop_rate: 0.75,
        intra_rarity_weight: 1,
      },
      {
        id: 'card-b',
        name: 'Card B',
        description: null,
        image_url: null,
        rarity: 'rare' as const,
        drop_rate: 0.25,
        intra_rarity_weight: 1,
      },
    ]

    const service = new GachaService()
    const selectCardFromPool = (service as any).selectCardFromPool.bind(service)

    // 同じ乱数・直前カードでも元の 75:25 重みでは A が不可避に連続する。
    expect(selectCardFromPool(pool, null, 'card-a')?.id).toBe('card-a')

    // レアリティ配分を 25:75 に反転すると effectiveWeight 側の反復抑制が B を選ぶ。
    const selected = selectCardFromPool(pool, { common: 25, rare: 75 }, 'card-a')
    expect(selected?.id).toBe('card-b')
    // effectiveWeight は選択専用で、下流へ返す drop_rate は元カードの値を維持する。
    expect(selected?.drop_rate).toBe(0.25)
  })
})
