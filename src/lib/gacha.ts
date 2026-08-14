export interface WeightedCard {
  id: string
  drop_rate: number
}

/**
 * [0, 1) の一様乱数を暗号学的に安全な乱数から生成する。
 *
 * crypto.getRandomValues は CSPRNG であり Math.random と違い予測不能。
 * IEEE754 double の仮数部と同じ 53bit の精度を使い切るため、上位 26bit と
 * 下位 27bit を 2 本の Uint32 から取り出して合成する（V8 の Math.random と
 * 同じ構成）。生成される値は 2^-53 刻みの 2^53 通りが厳密に等確率であり、
 * 剰余バイアス（modulo bias）は構造的に発生しない — 2^53 通りを 2^53 で
 * 割っているだけで、棄却も剰余も使っていないため。
 */
function secureRandomUnit(): number {
  const buf = new Uint32Array(2)
  crypto.getRandomValues(buf)
  // (26bit) * 2^27 + (27bit) → [0, 2^53) の整数 → 2^53 で割って [0, 1)
  return ((buf[0] >>> 6) * 0x8000000 + (buf[1] >>> 5)) / 0x20000000000000
}

/**
 * drop_rate を抽選重みとして安全に number 化する。
 *
 * DB ドライバや履歴 fixture が DECIMAL を文字列で返す場合があるため
 * (card-utils.ts の normalizeDropRate と同じ理由)、ここでも Number() を通す。
 * NaN・負値・null は「抽選対象外」を意味する 0 に倒す。負値をそのまま
 * 累積和へ入れると、後続カードの当選区間を食い潰して分布が壊れるため。
 */
function toWeight(value: unknown): number {
  const weight = Number(value ?? 0)
  return Number.isFinite(weight) && weight > 0 ? weight : 0
}

/**
 * 重み付き抽選で 1 件を選ぶ。選択確率は「そのカードの重み / プール内の重み合計」。
 * 重みの絶対値は問わず、渡された集合内の相対比だけで決まる（=プール内で暗黙に
 * 再正規化される。rarity-weight-calculator.ts の computeEffectiveWeights が
 * 合計 1 未満の実効重みを返せるのはこの性質に依存している）。
 *
 * 重みは浮動小数点のまま扱う。以前の実装は `Math.round(drop_rate * 10000)` で
 * 1e-4 刻みの整数へ量子化してから剰余で抽選していたが、これには 2 つの問題が
 * あった:
 *
 * 1. パック指定 + レアリティ自動配分 (Issue #579) の実効重みは
 *    `(レアリティ% / 100) / 同レアリティのカード枚数` という丸めていない小数で、
 *    1e-4 に対して十分小さくなりうる。例えば「5% のレアリティを 600 枚へ配分」
 *    では 1 枚あたり 0.0000833 が 1 単位(0.0001)へ切り上がり、そのレアリティ
 *    全体の排出率が設計値の 5% に対し 5.94%(+19%) へずれていた。
 * 2. 1 枚あたりの実効重みが 0.00005 未満になると量子化結果が 0 になり、
 *    そのカードは設定上は排出対象なのに永久に当たらなくなる。
 *
 * 浮動小数点の累積和には桁落ちがあるため、閾値が最後まで到達しなかった場合の
 * 保険として「重みが正だった最後のカード」を返す（items が空、または全カードの
 * 重みが 0 のときのみ null）。
 */
export function selectWeightedCard<T extends WeightedCard>(items: T[]): T | null {
  if (items.length === 0) return null

  let totalWeight = 0
  for (const item of items) {
    totalWeight += toWeight(item.drop_rate)
  }

  if (totalWeight <= 0) {
    return null
  }

  const threshold = secureRandomUnit() * totalWeight
  let cumulative = 0
  let lastWeighted: T | null = null

  for (const item of items) {
    const weight = toWeight(item.drop_rate)
    if (weight === 0) continue

    cumulative += weight
    lastWeighted = item
    if (threshold < cumulative) {
      return item
    }
  }

  return lastWeighted
}
