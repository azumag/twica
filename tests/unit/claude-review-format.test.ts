import { describe, expect, it } from 'vitest'
import {
  isOwnReviewComment,
  MAX_BODY_LENGTH,
  redactSecrets,
  truncateAndCloseFences,
} from '../../.github/scripts/format-review.mjs'

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('claude-review format helpers', () => {
  describe('redactSecrets', () => {
    it('redacts known token formats', () => {
      const input =
        'sk-ant-api03-abcdefghij0123456789 / ghp_12345678901234567890123456 / github_pat_11111_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      const out = redactSecrets(input)
      expect(out).not.toContain('sk-ant-api03')
      expect(out).not.toContain('ghp_12345678901234567890123456')
      expect(out).not.toContain('github_pat_11111')
      expect(out.match(/\[REDACTED\]/g)).toHaveLength(3)
    })

    it('leaves normal text and short identifiers untouched', () => {
      const input = 'actions/checkout@v4 と短いトークン ghp_12345 はそのまま'
      expect(redactSecrets(input)).toBe(input)
    })
  })

  describe('truncateAndCloseFences', () => {
    it('closes an unclosed fence even without truncation', () => {
      expect(truncateAndCloseFences('```js\nconst x = 1')).toBe('```js\nconst x = 1\n```')
    })

    it('keeps balanced fences untouched', () => {
      const text = '```js\nconst x = 1\n```'
      expect(truncateAndCloseFences(text)).toBe(text)
    })

    it('truncates long output and appends a note', () => {
      const long = `${'x'.repeat(MAX_BODY_LENGTH + 50)}\nlast`
      const out = truncateAndCloseFences(long)
      expect(out).toContain('（長すぎるため省略）')
      expect(Array.from(out).length).toBeLessThan(MAX_BODY_LENGTH + 50)
    })

    it('does not split surrogate pairs when truncating', () => {
      // 奇数長の接頭辞を足し、切り詰め境界がペアの中央に落ちるケースを踏む
      const out = truncateAndCloseFences('a' + '😀'.repeat(MAX_BODY_LENGTH))
      expect(LONE_SURROGATE.test(out)).toBe(false)
    })

    it('cuts at a line boundary when a newline is within the limit', () => {
      const lines = Array.from({ length: MAX_BODY_LENGTH }, (_, i) => `line-${i}`).join('\n')
      const out = truncateAndCloseFences(lines + '\n')
      expect(out.endsWith('（長すぎるため省略）')).toBe(true)
      // 注記を除いた本文の最終行が完全な line-N である = 途中の行を残さない
      const body = out.slice(0, out.indexOf('（長すぎるため省略）'))
      expect(body.trimEnd().split('\n').at(-1)).toMatch(/^line-\d+$/)
    })

    it('closes a fence opened before the cut and keeps the note outside', () => {
      const out = truncateAndCloseFences('```js\n' + 'x\n'.repeat(MAX_BODY_LENGTH))
      expect(out).toContain('（長すぎるため省略）')
      // 閉じフェンスが注記より前に来る = 注記はコードブロックの外
      expect(out.lastIndexOf('```')).toBeLessThan(out.indexOf('（長すぎるため省略）'))
    })

    it('does not truncate when the length is exactly at the limit', () => {
      const text = 'a'.repeat(MAX_BODY_LENGTH)
      expect(truncateAndCloseFences(text)).toBe(text)
    })
  })

  describe('redactSecrets edge cases', () => {
    it('greedily consumes trailing token characters (over-redaction is safe)', () => {
      const input = 'sk-ant-api03-abcdefghij0123456789X'
      expect(redactSecrets(input)).toBe('[REDACTED]')
    })

    it('redacts ghp_ tokens even when followed by an underscore', () => {
      expect(redactSecrets('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAA_')).toBe('[REDACTED]_')
    })

    it('redacts github_pat_ tokens even when followed by a hyphen', () => {
      expect(redactSecrets('github_pat_11111_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-')).toBe(
        '[REDACTED]-',
      )
    })

    it('redacts tokens embedded in multi-line text', () => {
      const input = 'line1 sk-ant-api03-abcdefghij0123456789\nline2'
      const out = redactSecrets(input)
      expect(out).toContain('[REDACTED]')
      expect(out).not.toContain('sk-ant-api03')
    })

    it('is idempotent', () => {
      const once = redactSecrets('sk-ant-api03-abcdefghij0123456789')
      expect(redactSecrets(once)).toBe(once)
    })
  })

  describe('isOwnReviewComment', () => {
    const marker = '<!-- claude-auto-review-preview -->'

    it('accepts a bot comment whose first line is the marker', () => {
      expect(
        isOwnReviewComment(
          { user: { type: 'Bot' }, body: `${marker}\n## Claude Auto Review` },
          marker,
        ),
      ).toBe(true)
    })

    it('rejects non-bot authors', () => {
      expect(
        isOwnReviewComment(
          { user: { type: 'User' }, body: `${marker}\n## Claude Auto Review` },
          marker,
        ),
      ).toBe(false)
    })

    it('rejects comments whose first line is not the marker', () => {
      expect(
        isOwnReviewComment({ user: { type: 'Bot' }, body: '## Claude Auto Review' }, marker),
      ).toBe(false)
    })

    it('handles missing body or comment safely', () => {
      expect(isOwnReviewComment({ user: { type: 'Bot' } }, marker)).toBe(false)
      expect(isOwnReviewComment(undefined, marker)).toBe(false)
    })
  })
})
