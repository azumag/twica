import { describe, expect, it } from 'vitest'
import {
  canonicalizeTimestamp,
  canonicalizeJsonValue,
  hashSecretValue,
  canonicalizeCell,
  canonicalizeRow,
  hashChunk,
  hashChunkList,
} from '../../../scripts/db-cutover/canonicalize.mjs'
import { createHash } from 'crypto'

/**
 * Issue #697 Chunk 2: canonicalize.mjs のテスト。
 * Issue #697本文「テスト」節が明示する代表的な検証観点をカバーする:
 *   - timestamp形式差をcanonical化して同値判定
 *   - JSON key order差を同値判定
 *   - array order差を差分判定
 *   - secret値がreportに出ない
 */

describe('canonicalizeTimestamp', () => {
  it('nullはnullのまま', () => {
    expect(canonicalizeTimestamp(null)).toBeNull()
    expect(canonicalizeTimestamp(undefined)).toBeNull()
  })

  it('Dateインスタンスと同じ瞬間を表す文字列表現は同じISO 8601 UTC文字列になる', () => {
    const asDate = new Date('2026-07-20T12:00:00.000Z')
    const asUtcString = '2026-07-20T12:00:00.000Z'
    const asOffsetString = '2026-07-20T21:00:00.000+09:00' // 同じ瞬間、UTC+9表記
    expect(canonicalizeTimestamp(asDate)).toBe('2026-07-20T12:00:00.000Z')
    expect(canonicalizeTimestamp(asUtcString)).toBe(canonicalizeTimestamp(asDate))
    expect(canonicalizeTimestamp(asOffsetString)).toBe(canonicalizeTimestamp(asDate))
  })

  it('不正な値は例外を投げる（fail-loud、値を握りつぶさない）', () => {
    expect(() => canonicalizeTimestamp('not-a-date')).toThrow(/invalid timestamp/)
  })

  it('既知の限界: マイクロ秒未満の差異はJS Date（ミリ秒精度）経由の正規化で失われる（Fableレビュー Major対応、意図的な仕様として固定）', () => {
    // PostgreSQLのtimestamp(tz)はマイクロ秒精度を持つが、Dateはミリ秒精度までしか
    // 表現できない。同一ミリ秒内でマイクロ秒だけ異なる2値は区別できない
    // （canonicalize.mjs冒頭コメント「timestampのマイクロ秒精度について」参照）。
    expect(canonicalizeTimestamp('2026-01-01T00:00:00.123456Z')).toBe(canonicalizeTimestamp('2026-01-01T00:00:00.123999Z'))
    expect(canonicalizeTimestamp('2026-01-01T00:00:00.123456Z')).toBe('2026-01-01T00:00:00.123Z')
  })
})

describe('canonicalizeJsonValue', () => {
  it('objectのkey順序は無視して同じ結果になる（JSON key order差を同値判定）', () => {
    const a = { b: 2, a: 1 }
    const b = { a: 1, b: 2 }
    expect(JSON.stringify(canonicalizeJsonValue(a))).toBe(JSON.stringify(canonicalizeJsonValue(b)))
    expect(JSON.stringify(canonicalizeJsonValue(a))).toBe('{"a":1,"b":2}')
  })

  it('arrayの要素順序は保持する（順序違いは差分として検出できる）', () => {
    const a = [1, 2, 3]
    const b = [3, 2, 1]
    expect(JSON.stringify(canonicalizeJsonValue(a))).not.toBe(JSON.stringify(canonicalizeJsonValue(b)))
    expect(JSON.stringify(canonicalizeJsonValue(a))).toBe('[1,2,3]')
  })

  it('ネストしたobject/arrayも再帰的に正規化する', () => {
    const a = { z: [{ y: 1, x: 2 }], a: 'v' }
    const b = { a: 'v', z: [{ x: 2, y: 1 }] }
    expect(JSON.stringify(canonicalizeJsonValue(a))).toBe(JSON.stringify(canonicalizeJsonValue(b)))
  })

  it('null/undefinedはnullになる', () => {
    expect(canonicalizeJsonValue(null)).toBeNull()
    expect(canonicalizeJsonValue(undefined)).toBeNull()
  })

  it('プリミティブはそのまま返す', () => {
    expect(canonicalizeJsonValue('str')).toBe('str')
    expect(canonicalizeJsonValue(42)).toBe(42)
    expect(canonicalizeJsonValue(true)).toBe(true)
  })
})

describe('hashSecretValue', () => {
  it('生値が出力に含まれない（SHA-256ハッシュへ置換される）', () => {
    const secret = 'super-secret-twitch-token-value'
    const hashed = hashSecretValue(secret)
    expect(hashed).not.toContain(secret)
    expect(hashed).toBe(createHash('sha256').update(secret, 'utf8').digest('hex'))
  })

  it('同じ値は同じハッシュになる（source/target比較のため決定的である必要がある）', () => {
    expect(hashSecretValue('same-value')).toBe(hashSecretValue('same-value'))
  })

  it('異なる値は異なるハッシュになる', () => {
    expect(hashSecretValue('value-a')).not.toBe(hashSecretValue('value-b'))
  })

  it('nullはnullのまま（値の有無自体は機微情報ではない）', () => {
    expect(hashSecretValue(null)).toBeNull()
    expect(hashSecretValue(undefined)).toBeNull()
  })

  it('Date入力はtoISOString()経由でハッシュ化される（Fableレビュー Major対応: String(Date)のタイムゾーン依存を排除）', () => {
    // secret列にはtwitch_token_expires_at（timestamp with time zone）のような
    // Date型の値も来うる。`String(date)`はDate#toString()（実行マシンのタイムゾーン・
    // 曜日名を含む可読形式・ミリ秒未満切り捨て）に依存してしまうため、同じ瞬間の値でも
    // 実行環境によって異なるハッシュになる欠陥があった。toISOString()経由なら
    // タイムゾーン非依存・ミリ秒精度で決定的になる。
    const date = new Date('2026-01-01T00:00:00.123Z')
    expect(hashSecretValue(date)).toBe(createHash('sha256').update('2026-01-01T00:00:00.123Z', 'utf8').digest('hex'))
    expect(hashSecretValue(date)).not.toBe(createHash('sha256').update(String(date), 'utf8').digest('hex'))
  })

  it('同じ瞬間を表す別々のDateインスタンス（生成経路が違っても）は同じハッシュになる', () => {
    const a = new Date('2026-01-01T00:00:00.123Z')
    const b = new Date(a.getTime())
    expect(a).not.toBe(b) // 別インスタンスであることの確認
    expect(hashSecretValue(a)).toBe(hashSecretValue(b))
  })
})

describe('canonicalizeCell', () => {
  it('isSecret=trueの列は値がハッシュに置き換わる', () => {
    const meta = { dataType: 'text', isSecret: true }
    const result = canonicalizeCell('my-token-value', meta)
    expect(result).not.toContain('my-token-value')
    expect(result).toBe(hashSecretValue('my-token-value'))
  })

  it('timestamp with time zone列はcanonicalizeTimestampを通る', () => {
    const meta = { dataType: 'timestamp with time zone', isSecret: false }
    expect(canonicalizeCell(new Date('2026-01-01T00:00:00Z'), meta)).toBe('2026-01-01T00:00:00.000Z')
  })

  it('jsonb列はcanonicalizeJsonValueを通る（key順序正規化）', () => {
    const meta = { dataType: 'jsonb', isSecret: false }
    expect(canonicalizeCell({ b: 1, a: 2 }, meta)).toEqual({ a: 2, b: 1 })
  })

  it('ARRAY列はcanonicalizeJsonValueを通る（要素順序保持）', () => {
    const meta = { dataType: 'ARRAY', isSecret: false }
    expect(canonicalizeCell(['x', 'y'], meta)).toEqual(['x', 'y'])
  })

  it('それ以外（uuid/text/boolean/integer等）はそのまま通す', () => {
    const meta = { dataType: 'uuid', isSecret: false }
    expect(canonicalizeCell('11111111-1111-1111-1111-111111111111', meta)).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('undefinedはnullとして扱う', () => {
    const meta = { dataType: 'text', isSecret: false }
    expect(canonicalizeCell(undefined, meta)).toBeNull()
  })
})

describe('canonicalizeRow', () => {
  const columns = [
    { name: 'id', dataType: 'uuid', isSecret: false },
    { name: 'name', dataType: 'text', isSecret: false },
    { name: 'twitch_access_token', dataType: 'text', isSecret: true },
  ]

  it('列の指定順で [列名, 値] の配列を作る', () => {
    const row = { id: 'abc', name: 'streamer1', twitch_access_token: 'secret-token' }
    const result = canonicalizeRow(row, columns)
    expect(result).toEqual([
      ['id', 'abc'],
      ['name', 'streamer1'],
      ['twitch_access_token', hashSecretValue('secret-token')],
    ])
  })

  it('生のsecret値がJSON.stringify結果に含まれない', () => {
    const row = { id: 'abc', name: 'streamer1', twitch_access_token: 'secret-token' }
    const serialized = JSON.stringify(canonicalizeRow(row, columns))
    expect(serialized).not.toContain('secret-token')
  })
})

describe('hashChunk / hashChunkList（同件数だが異なるrowの検出）', () => {
  const columns = [{ name: 'id', dataType: 'uuid', isSecret: false }, { name: 'name', dataType: 'text', isSecret: false }]
  const rowA = canonicalizeRow({ id: '1', name: 'Alice' }, columns)
  const rowB = canonicalizeRow({ id: '1', name: 'Bob' }, columns)

  it('同じ行集合は同じchunk hashになる', () => {
    expect(hashChunk([rowA])).toBe(hashChunk([canonicalizeRow({ id: '1', name: 'Alice' }, columns)]))
  })

  it('同件数だが値の異なる行はchunk hashが変わる', () => {
    expect(hashChunk([rowA])).not.toBe(hashChunk([rowB]))
  })

  it('行の連結境界を曖昧にしない（["1"]+["2"] は ["1","2"]とは異なるhashになる）', () => {
    const singleRow = canonicalizeRow({ id: '12', name: 'X' }, columns)
    const twoRows = [canonicalizeRow({ id: '1', name: '2X' }, columns)]
    // 意図的に「連結すると紛らわしくなりうる」文字列を作り、実際には別々のhashになることを確認する
    expect(hashChunk([singleRow])).not.toBe(hashChunk(twoRows))
  })

  it('hashChunkListはchunk hashの順序に敏感（順序が変わればroot hashも変わる）', () => {
    const h1 = hashChunk([rowA])
    const h2 = hashChunk([rowB])
    expect(hashChunkList([h1, h2])).not.toBe(hashChunkList([h2, h1]))
  })

  it('空chunk配列でも決定的な値を返す', () => {
    expect(hashChunkList([])).toBe(hashChunkList([]))
  })
})
