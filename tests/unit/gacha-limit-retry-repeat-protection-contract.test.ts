import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const gachaServiceSource = readFileSync(
  resolve(process.cwd(), 'src/lib/services/gacha.ts'),
  'utf8',
)

describe('GachaService limit_reached retry repeat-protection contract (#1302)', () => {
  it('再抽選でも同じ previousCardId を selectCardFromPool へ渡す', () => {
    const retryLoopStart = gachaServiceSource.indexOf('for (let attempt = 1; ; attempt += 1)')
    const successReturn = gachaServiceSource.indexOf(
      'card: selectedCard,',
      retryLoopStart,
    )

    expect(retryLoopStart).toBeGreaterThanOrEqual(0)
    expect(successReturn).toBeGreaterThan(retryLoopStart)

    const retryLoop = gachaServiceSource.slice(retryLoopStart, successReturn)

    // limit_reached では pool だけを更新して同じ loop 先頭へ戻る。
    // previousCardId を再計算・破棄せず、初回と同じ反復抑制条件で再選択する契約を固定する。
    expect(retryLoop).toContain(
      'this.selectCardFromPool(pool, resolvedRarityWeights, previousCardId)',
    )
    expect(retryLoop).toMatch(
      /if \(rpcResult\?\.limit_reached\) \{[\s\S]*?pool = pool\.filter\([\s\S]*?continue[\s\S]*?\}/,
    )
    expect(retryLoop).not.toMatch(/previousCardId\s*=/)
  })
})
