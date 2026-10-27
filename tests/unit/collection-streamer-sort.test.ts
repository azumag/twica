/**
 * #1953: マイコレクション一覧の配信者の並び替え（純関数）。
 * recent / name / completion の各モードと、タイブレークの決定性、
 * 不正な ?sort= のフォールバックを固定する。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STREAMER_COLLECTION_SORT,
  parseStreamerCollectionSort,
  sortStreamerCollections,
} from '@/lib/collection-utils'

function entry(id: string, name: string, ownedActive = 0, totalActive = 0) {
  return { streamer: { id, twitch_display_name: name }, ownedActive, totalActive }
}

const ids = (items: Array<{ streamer: { id: string } }>) => items.map((i) => i.streamer.id)

describe('parseStreamerCollectionSort', () => {
  it('許可された3モードをそのまま返す', () => {
    expect(parseStreamerCollectionSort('recent')).toBe('recent')
    expect(parseStreamerCollectionSort('name')).toBe('name')
    expect(parseStreamerCollectionSort('completion')).toBe('completion')
  })

  it('未指定・不正値・空文字・配列・大文字違いは既定(recent)にフォールバックする', () => {
    expect(DEFAULT_STREAMER_COLLECTION_SORT).toBe('recent')
    expect(parseStreamerCollectionSort(undefined)).toBe('recent')
    expect(parseStreamerCollectionSort('')).toBe('recent')
    expect(parseStreamerCollectionSort('rarity')).toBe('recent')
    expect(parseStreamerCollectionSort('NAME')).toBe('recent')
    expect(parseStreamerCollectionSort(['name', 'completion'])).toBe('recent')
    expect(parseStreamerCollectionSort('__proto__')).toBe('recent')
  })
})

describe('sortStreamerCollections', () => {
  it('recent: 最後に獲得した日時が新しい配信者が先', () => {
    const items = [entry('a', 'A'), entry('b', 'B'), entry('c', 'C')]
    const last = new Map<string, string | null>([
      ['a', '2026-10-01T00:00:00.000000Z'],
      ['b', '2026-10-20T00:00:00.000000Z'],
      ['c', '2026-10-10T00:00:00.000000Z'],
    ])
    expect(ids(sortStreamerCollections(items, 'recent', last))).toEqual(['b', 'c', 'a'])
  })

  it('recent: 日時不明(欠落・null・不正値)は最後尾へ回り、その中は表示名順', () => {
    const items = [entry('z', 'Zed'), entry('n', 'Null'), entry('k', 'Known'), entry('m', 'Missing')]
    const last = new Map<string, string | null>([
      ['k', '2026-10-01T00:00:00.000000Z'],
      ['n', null],
      ['z', 'not-a-date'],
    ])
    expect(ids(sortStreamerCollections(items, 'recent', last))).toEqual(['k', 'm', 'n', 'z'])
  })

  it('recent: 取得失敗(空Map)でも表示名順で決定的に並ぶ', () => {
    const items = [entry('b', 'Bravo'), entry('a', 'Alpha')]
    expect(ids(sortStreamerCollections(items, 'recent'))).toEqual(['a', 'b'])
  })

  it('recent: 同時刻は表示名→idの順で決着する', () => {
    const t = '2026-10-01T00:00:00.000000Z'
    const items = [entry('2', 'Same'), entry('1', 'Same'), entry('0', 'Another')]
    const last = new Map<string, string | null>([['0', t], ['1', t], ['2', t]])
    expect(ids(sortStreamerCollections(items, 'recent', last))).toEqual(['0', '1', '2'])
  })

  it('name: 日本語を含む表示名を ja ロケールで並べる(かな→漢字などで入力順に依存しない)', () => {
    const items = [entry('3', 'ねこ'), entry('1', 'あおい'), entry('2', 'Alice'), entry('4', 'うみ')]
    const sorted = sortStreamerCollections(items, 'name')
    // ラテン文字が日本語より前、かなは五十音順
    expect(ids(sorted)).toEqual(['2', '1', '4', '3'])
  })

  it('name: 表示名が同じならstreamer.idで決着し、入力順を反転しても結果が同じ', () => {
    const items = [entry('b', 'Same'), entry('a', 'Same'), entry('c', 'Same')]
    expect(ids(sortStreamerCollections(items, 'name'))).toEqual(['a', 'b', 'c'])
    expect(ids(sortStreamerCollections([...items].reverse(), 'name'))).toEqual(['a', 'b', 'c'])
  })

  it('completion: アクティブカードの所持率が高い順(枚数ではなく率)', () => {
    const items = [
      entry('half', 'Half', 5, 10),
      entry('full', 'Full', 3, 3),
      entry('low', 'Low', 1, 10),
      // 所持数は多いが率は低い
      entry('big', 'Big', 20, 100),
    ]
    expect(ids(sortStreamerCollections(items, 'completion'))).toEqual(['full', 'half', 'big', 'low'])
  })

  it('completion: 同率は表示名→id、アクティブ0枚は率0として扱い最後尾側で表示名順', () => {
    const items = [
      entry('x', 'Empty', 0, 0),
      entry('b', 'Bee', 1, 2),
      entry('a', 'Ay', 1, 2),
      // totalActive が 0 でも ownedActive が非0(非アクティブ所持)で NaN/Infinity にならない
      entry('w', 'Weird', 4, 0),
    ]
    expect(ids(sortStreamerCollections(items, 'completion'))).toEqual(['a', 'b', 'x', 'w'])
  })

  it('入力配列を破壊的に変更しない', () => {
    const items = [entry('b', 'B'), entry('a', 'A')]
    const snapshot = [...items]
    sortStreamerCollections(items, 'name')
    expect(items).toEqual(snapshot)
  })
})
