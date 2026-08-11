export interface WeightedCard {
  id: string
  drop_rate: number
}

/**
 * 0 <= result < max の一様整数を暗号学的に安全な乱数で返す。
 * crypto.getRandomValues は CSPRNG であり Math.random と違い予測不能。
 * 剰余バイアスを避けるため、上限を超える値は棄却して再抽選する。
 */
function secureRandomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max
  const buf = new Uint32Array(1)
  let value: number
  do {
    crypto.getRandomValues(buf)
    value = buf[0]
  } while (value >= limit)
  return value % max
}

export function selectWeightedCard<T extends WeightedCard>(items: T[]): T | null {
  if (items.length === 0) return null

  const totalWeightInt = items.reduce((sum, item) => {
    return sum + Math.round((item.drop_rate || 0) * 10000)
  }, 0)

  if (totalWeightInt === 0) {
    return null
  }

  const random = secureRandomInt(totalWeightInt)
  let cumulative = 0

  for (const item of items) {
    cumulative += Math.round((item.drop_rate || 0) * 10000)
    if (random < cumulative) {
      return item
    }
  }

  return null
}
