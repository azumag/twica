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

function collectMessages(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectMessages(child, `${prefix}${key}.`)
    )
  }
  return []
}

// next-intl のメッセージ引数は `{name}` の形式で記述されるため、キー集合だけでなく
// 各キーの引数名集合も比較する。片方の翻訳だけ引数を削除・改名すると、実行時に
// プレースホルダーがそのまま表示されるため、翻訳追加時点で検出できるようにする。
function collectPlaceholders(message: string): string[] {
  return [...message.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort()
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

  it('各メッセージのプレースホルダー集合が一致する', () => {
    const jaMessagesByKey = new Map(collectMessages(jaMessages))
    const enMessagesByKey = new Map(collectMessages(enMessages))
    const differences = [...jaMessagesByKey.keys()].flatMap((key) => {
      const jaPlaceholders = collectPlaceholders(jaMessagesByKey.get(key) ?? '')
      const enPlaceholders = collectPlaceholders(enMessagesByKey.get(key) ?? '')
      return JSON.stringify(jaPlaceholders) === JSON.stringify(enPlaceholders)
        ? []
        : [{ key, jaPlaceholders, enPlaceholders }]
    })

    expect(differences).toEqual([])
  })
})
