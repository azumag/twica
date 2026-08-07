import { describe, it, expect } from 'vitest'
import { CARD_DESCRIPTION_MAX_CHARACTERS, ERROR_MESSAGES } from '@/lib/constants'
import { countCharacters, truncateCharacters } from '@/lib/text-utils'
import {
  validateCardDescription,
  validateRarity,
  validateRewardId,
  validateRewardName,
  validateChatAnnouncementTemplate,
} from '@/lib/validations'

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

describe('validateRarity', () => {
  it('allows built-in and custom rarity labels', () => {
    expect(validateRarity('legendary')).toEqual({ valid: true })
    expect(validateRarity('mythic')).toEqual({ valid: true })
    expect(validateRarity('イベント限定')).toEqual({ valid: true })
  })

  it('rejects blank, oversized, and control-character rarity labels', () => {
    expect(validateRarity('   ')).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_RARITY,
    })
    expect(validateRarity('a'.repeat(41))).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_RARITY,
    })
    expect(validateRarity('rare\nhidden')).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_RARITY,
    })
  })
})

describe('validateRewardId (issue #836)', () => {
  const validUuid = '11111111-1111-1111-1111-111111111111'

  it('UUID 形式を許可する（大文字小文字を問わない）', () => {
    expect(validateRewardId(validUuid)).toEqual({ valid: true })
    expect(validateRewardId(validUuid.toUpperCase())).toEqual({ valid: true })
  })

  it('null / undefined は許可する（設定なし・クリアを意味する）', () => {
    expect(validateRewardId(null)).toEqual({ valid: true })
    expect(validateRewardId(undefined)).toEqual({ valid: true })
  })

  it('空文字列は許可する（クライアントは報酬未選択時に "" を送る）', () => {
    expect(validateRewardId('')).toEqual({ valid: true })
    expect(validateRewardId('  ')).toEqual({ valid: true })
  })

  it('非 UUID 文字列・非文字列を拒否する', () => {
    expect(validateRewardId('reward-123')).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
    expect(validateRewardId(12345)).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
    expect(validateRewardId('11111111-1111-1111-1111-11111111111g')).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
  })
})

describe('validateRewardName (issue #836)', () => {
  it('null / undefined と 1〜100 字の文字列を許可する', () => {
    expect(validateRewardName(null)).toEqual({ valid: true })
    expect(validateRewardName(undefined)).toEqual({ valid: true })
    expect(validateRewardName('Test Reward')).toEqual({ valid: true })
    expect(validateRewardName('a'.repeat(100))).toEqual({ valid: true })
  })

  it('101字以上・空文字・制御文字を含む名前を拒否する', () => {
    expect(validateRewardName('a'.repeat(101))).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
    expect(validateRewardName('   ')).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
    expect(validateRewardName('bad\nname')).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
  })

  it('非文字列を拒否する', () => {
    expect(validateRewardName(123)).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
  })
})

describe('validateChatAnnouncementTemplate (issue #836)', () => {
  it('null / undefined と上限内の文字列を許可する', () => {
    expect(validateChatAnnouncementTemplate(null)).toEqual({ valid: true })
    expect(validateChatAnnouncementTemplate(undefined)).toEqual({ valid: true })
    expect(validateChatAnnouncementTemplate('@{user} がカードを獲得しました！')).toEqual({ valid: true })
    expect(validateChatAnnouncementTemplate('a'.repeat(500))).toEqual({ valid: true })
  })

  it('複数行テンプレート（改行・タブ）を許可する', () => {
    expect(validateChatAnnouncementTemplate('1行目\n2行目')).toEqual({ valid: true })
    expect(validateChatAnnouncementTemplate('@{user} が獲得！\r\n詳細は {card}')).toEqual({ valid: true })
    expect(validateChatAnnouncementTemplate('タブ\t区切り')).toEqual({ valid: true })
  })

  it('上限超過・制御文字（改行以外）・空白のみ・非文字列を拒否する', () => {
    expect(validateChatAnnouncementTemplate('a'.repeat(501))).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
    expect(validateChatAnnouncementTemplate('bad\u0007bell')).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
    expect(validateChatAnnouncementTemplate('   ')).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
    expect(validateChatAnnouncementTemplate(123)).toEqual({
      valid: false,
      error: ERROR_MESSAGES.INVALID_REQUEST,
    })
  })
})
