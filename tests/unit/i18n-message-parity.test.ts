import { describe, expect, it } from 'vitest'
import jaMessages from '../../messages/ja.json'
import enMessages from '../../messages/en.json'

/**
 * messages/ja.json と messages/en.json のキー集合が完全に一致することの回帰テスト（#835）。
 *
 * 英語ロケールのユーザーに翻訳なしの文言が表示される（またはキー名がそのまま表示される）
 * 事故を防ぐため、トップレベル全スコープを深層比較する。キーを追加する場合は必ず
 * 両ファイルに追加すること。
 */
function collectKeys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
      prefix + key,
      ...collectKeys(child, `${prefix}${key}.`),
    ])
  }
  return []
}

describe('i18n メッセージキー・パリティ (ja/en)', () => {
  it('トップレベルのスコープ集合が一致する', () => {
    expect(Object.keys(jaMessages).sort()).toEqual(Object.keys(enMessages).sort())
  })

  it('全スコープのキー集合が深層で一致する', () => {
    const jaKeys = collectKeys(jaMessages)
    const enKeys = collectKeys(enMessages)
    const jaOnly = jaKeys.filter((k) => !enKeys.includes(k)).sort()
    const enOnly = enKeys.filter((k) => !jaKeys.includes(k)).sort()

    expect({
      'jaのみに存在するキー（en.jsonへの追加漏れ）': jaOnly,
      'enのみに存在するキー（ja.jsonへの追加漏れ）': enOnly,
    }).toEqual({
      'jaのみに存在するキー（en.jsonへの追加漏れ）': [],
      'enのみに存在するキー（ja.jsonへの追加漏れ）': [],
    })
  })
})
