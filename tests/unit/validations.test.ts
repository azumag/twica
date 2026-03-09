import { describe, it, expect } from 'vitest'
import { CARD_DESCRIPTION_MAX_CHARACTERS, ERROR_MESSAGES } from '@/lib/constants'
import { countCharacters, truncateCharacters } from '@/lib/text-utils'
import { validateCardDescription } from '@/lib/validations'

describe('countCharacters', () => {
  it('日本語文字列を文字単位で数える', () => {
    expect(countCharacters('あいうえお')).toBe(5)
  })

  it('結合文字を1文字として数える', () => {
    expect(countCharacters('か\u3099')).toBe(1)
  })

  it('文字数上限で切り詰める', () => {
    expect(truncateCharacters('あいうえお', 3)).toBe('あいう')
  })
})

describe('validateCardDescription', () => {
  it('日本語500文字の説明を許可する', () => {
    const description = 'あ'.repeat(CARD_DESCRIPTION_MAX_CHARACTERS)

    expect(validateCardDescription(description)).toEqual({ valid: true })
  })

  it('日本語501文字の説明を拒否する', () => {
    const description = 'あ'.repeat(CARD_DESCRIPTION_MAX_CHARACTERS + 1)

    expect(validateCardDescription(description)).toEqual({
      valid: false,
      error: ERROR_MESSAGES.DESCRIPTION_TOO_LONG,
    })
  })
})
