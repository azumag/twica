import { describe, expect, it } from 'vitest'
import { isCanonicalUuid, normalizeUuid } from '@/lib/uuid-validation'

describe('isCanonicalUuid', () => {
  it.each([
    '94cb6927-8733-4f1c-8e7e-0afb89773daa',
    // 既存overlay検証が許可していた大文字表記は後方互換として維持する。
    '94CB6927-8733-4F1C-8E7E-0AFB89773DAA',
  ])('標準の8-4-4-4-12構造を受理する: %s', (value) => {
    expect(isCanonicalUuid(value)).toBe(true)
  })

  it.each([
    // Issue #908で本番へ到達した35文字の値。
    'e92022fd-3d30-b840-c78bbea56920',
    '94cb6927-8733-4f1c-8e7e-0afb89773daasuffix',
    '{94cb6927-8733-4f1c-8e7e-0afb89773daa}',
    '94cb692787334f1c8e7e0afb89773daa',
    ' 94cb6927-8733-4f1c-8e7e-0afb89773daa',
  ])('アプリが生成しないUUID表記を拒否する: %s', (value) => {
    expect(isCanonicalUuid(value)).toBe(false)
  })
})

describe('normalizeUuid', () => {
  // #2061: DBが返す小文字表記へ揃える。小文字入力は変わらない（冪等）。
  it('大文字表記を小文字へ正規化する', () => {
    expect(normalizeUuid('94CB6927-8733-4F1C-8E7E-0AFB89773DAA')).toBe(
      '94cb6927-8733-4f1c-8e7e-0afb89773daa',
    )
  })

  it('小文字入力をそのまま返す', () => {
    expect(normalizeUuid('94cb6927-8733-4f1c-8e7e-0afb89773daa')).toBe(
      '94cb6927-8733-4f1c-8e7e-0afb89773daa',
    )
  })
})
