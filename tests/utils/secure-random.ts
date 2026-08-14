import { vi } from 'vitest'

/**
 * src/lib/gacha.ts の secureRandomUnit（crypto.getRandomValues から 53bit の
 * [0,1) 一様乱数を合成する）を、指定したフラクションを返すように固定する。
 *
 * secureRandomUnit は Uint32Array(2) を 1 本引き、
 *   unit = ((buf[0] >>> 6) * 2^27 + (buf[1] >>> 5)) / 2^53
 * を返す。ここではその逆変換で `fraction × 2^53` を上位 26bit / 下位 27bit へ
 * 分解して書き戻す。抽選側の閾値は「unit × プール重み合計」なので、呼び出し側は
 * 重みのスケール（旧実装の drop_rate × 10000 のような量子化単位）を意識せず
 * 境界条件を直接指定できる。
 *
 * secureRandomUnit の内部表現に密結合したヘルパーなので、
 * gacha.test.ts / gacha-service.test.ts へ個別にコピーせずここへ集約する
 * （実装変更時に片方だけ直し忘れる事故を防ぐため）。
 *
 * fraction は [0, 1) の外を渡すと検証したい境界とは別の値を黙って検証して
 * しまうため、範囲外は握りつぶさず throw する。
 */
export function mockSecureRandomUnit(fraction: number) {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
    throw new RangeError(`mockSecureRandomUnit: fraction must be in [0, 1), got ${fraction}`)
  }

  const scaled = Math.min(Math.floor(fraction * 0x20000000000000), 0x1fffffffffffff)
  const high = Math.floor(scaled / 0x8000000)
  const low = scaled % 0x8000000

  return vi.spyOn(crypto, 'getRandomValues').mockImplementation((buf) => {
    // 対象は secureRandomUnit が使う Uint32Array(2) のみ。
    // high << 6 は int32 として負値になるが、Uint32Array への代入時の
    // ToUint32 で正しい上位ビットへ戻る。
    if (buf instanceof Uint32Array && buf.length >= 2) {
      buf[0] = high << 6
      buf[1] = low << 5
    }
    return buf
  })
}
