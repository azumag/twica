export interface WeightedCard {
  id: string
  drop_rate: number
}

export function selectWeightedCard<T extends WeightedCard>(items: T[]): T | null {
  if (items.length === 0) return null

  const totalWeight = items.reduce((sum, item) => sum + (item.drop_rate || 1), 0)
  let random = Math.random() * totalWeight

  for (const item of items) {
    const weight = item.drop_rate || 1
    random -= weight
    if (random <= 0) {
      return item
    }
  }

  return items[items.length - 1]
}
