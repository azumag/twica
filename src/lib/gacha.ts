export interface WeightedCard {
  id: string
  drop_rate: number
}

export function selectWeightedCard<T extends WeightedCard>(items: T[]): T | null {
  if (items.length === 0) return null

  const totalWeightInt = items.reduce((sum, item) => {
    return sum + Math.round((item.drop_rate || 0) * 10000)
  }, 0)

  if (totalWeightInt === 0) {
    return null
  }

  const random = Math.floor(Math.random() * totalWeightInt)
  let cumulative = 0

  for (const item of items) {
    cumulative += Math.round((item.drop_rate || 0) * 10000)
    if (random < cumulative) {
      return item
    }
  }

  return null
}
