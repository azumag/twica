import { describe, expect, it } from 'vitest'
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
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

// next-intl は単純な `{name}` だけでなく、plural/select/number/date の ICU 構文も
// 受け付ける。正規表現では formatted argument や分岐内の引数を取りこぼし、文字列
// リテラルを誤検出するため、実行時と同じFormatJSのASTパーサーで引数名を収集する。
function collectPlaceholders(message: string): string[] {
  const placeholders = new Set<string>()

  const visit = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      switch (element.type) {
        case TYPE.argument:
        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
        case TYPE.select:
        case TYPE.plural:
          placeholders.add(element.value)
          if (element.type === TYPE.select || element.type === TYPE.plural) {
            Object.values(element.options).forEach((option) => visit(option.value))
          }
          break
        case TYPE.tag:
          visit(element.children)
          break
        case TYPE.literal:
        case TYPE.pound:
          break
      }
    }
  }

  visit(parse(message))
  return [...placeholders].sort()
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

  it('ICUのformatted・分岐内引数を検出し、リテラル波括弧を引数扱いしない', () => {
    expect(
      collectPlaceholders(
        "{count, plural, =0 {該当なし} other {{count, number}件、{name}さん}} '{literal}'"
      )
    ).toEqual(['count', 'name'])
  })
})
