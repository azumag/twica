import { describe, expect, it } from 'vitest'
import { isCanonicalUuid, normalizeCanonicalUuid } from '@/lib/uuid-validation'

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

describe('normalizeCanonicalUuid (#2061)', () => {
  it.each([
    ['94cb6927-8733-4f1c-8e7e-0afb89773daa', '94cb6927-8733-4f1c-8e7e-0afb89773daa'],
    // DBのuuid出力（小文字）に合わせて大文字を小文字化する。
    ['94CB6927-8733-4F1C-8E7E-0AFB89773DAA', '94cb6927-8733-4f1c-8e7e-0afb89773daa'],
    ['94Cb6927-8733-4f1C-8e7E-0afb89773dAa', '94cb6927-8733-4f1c-8e7e-0afb89773daa'],
  ])('標準UUIDを小文字にして返す: %s', (value, expected) => {
    expect(normalizeCanonicalUuid(value)).toBe(expected)
  })

  it.each([
    // isCanonicalUuid が拒否する表記は正規化せず null を返す。
    '{94cb6927-8733-4f1c-8e7e-0afb89773daa}',
    '94cb692787334f1c8e7e0afb89773daa',
    'e92022fd-3d30-b840-c78bbea56920',
    'not-a-uuid',
    '',
  ])('標準UUIDでない値には null を返す: %s', (value) => {
    expect(normalizeCanonicalUuid(value)).toBeNull()
  })
})
