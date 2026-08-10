import { describe, expect, it } from 'vitest'
import {
  buildReviewCommentBody,
  findOwnReviewComment,
  isOverLimit,
  MAX_BODY_LENGTH,
  parseReviewJson,
  redactSecrets,
  REVIEW_MARKER,
  sanitizeReviewText,
  truncateAndCloseFences,
} from '../../.github/scripts/format-review.mjs'

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

    it('redacts the claude setup-token OAuth format (sk-ant-oat01-)', () => {
      expect(redactSecrets('sk-ant-oat01-abcdefghij0123456789')).toBe('[REDACTED]')
    })

    it('redacts tokens that follow a word character (no leading boundary)', () => {
      // \b を付けない設計判断の回帰テスト
      expect(redactSecrets('Xsk-ant-api03-abcdefghij0123456789')).toBe('X[REDACTED]')
    })

    it('redacts ghp_ tokens even when followed by an underscore', () => {
      expect(redactSecrets('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAA_')).toBe('[REDACTED]_')
    })

    it('redacts github_pat_ tokens even when followed by a hyphen', () => {
      expect(redactSecrets('github_pat_11111_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-')).toBe(
        '[REDACTED]-',
      )
    })

    it('redacts all gh*_ token prefixes (p, o, u, s, r)', () => {
      for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
        expect(redactSecrets(prefix + 'A'.repeat(24))).toBe('[REDACTED]')
      }
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

  describe('truncateAndCloseFences', () => {
    it('isOverLimit reports only lengths above the limit', () => {
      expect(isOverLimit('a'.repeat(MAX_BODY_LENGTH))).toBe(false)
      expect(isOverLimit('a'.repeat(MAX_BODY_LENGTH + 1))).toBe(true)
    })

    it('keeps text unchanged within the limit', () => {
      const text = '```js\nconst x = 1\n```'
      expect(truncateAndCloseFences(text)).toBe(text)
    })

    it('appends a note on overflow and stays within the limit plus overhead', () => {
      const out = truncateAndCloseFences('x'.repeat(MAX_BODY_LENGTH + 50))
      expect(out).toContain('（長すぎるため省略）')
      expect(out.length).toBeLessThanOrEqual(MAX_BODY_LENGTH + 16)
    })

    it('leaves odd-fence text unchanged without truncation', () => {
      // 非切り詰め時はフェンス補完しない（コード引用の誤判定を避ける）
      expect(truncateAndCloseFences('```js\nconst x = 1')).toBe('```js\nconst x = 1')
    })

    it('closes a fence opened before the cut and appends the note after it', () => {
      const out = truncateAndCloseFences('```js\n' + 'x'.repeat(MAX_BODY_LENGTH))
      expect(out.lastIndexOf('```')).toBeGreaterThan(0)
      expect(out.lastIndexOf('```')).toBeLessThan(out.indexOf('（長すぎるため省略）'))
      // 改行が先頭付近にしか無い長文でも本文をほぼ失わない（行カットの下限）
      expect(out.length).toBeGreaterThan(1000)
    })

    it('leaves text at exactly the limit unchanged', () => {
      const text = 'a'.repeat(MAX_BODY_LENGTH)
      expect(truncateAndCloseFences(text)).toBe(text)
    })

    it('does not add a closing fence when fences are balanced after truncation', () => {
      // 切り詰め後も開閉フェンスが両方残る入力（閉じフェンスが切り落とされない）
      const text = '```js\n' + 'x'.repeat(MAX_BODY_LENGTH - 20) + '\n```\n' + 'y'.repeat(100)
      const out = truncateAndCloseFences(text)
      expect(out).toContain('（長すぎるため省略）')
      expect(out.match(/```/g)).toHaveLength(2)
    })

    it('drops a lone high surrogate left at the cut', () => {
      const out = truncateAndCloseFences('a'.repeat(MAX_BODY_LENGTH - 1) + '😀' + 'b'.repeat(10))
      expect(/[\uD800-\uDBFF]/.test(out)).toBe(false)
    })
  })

  describe('sanitizeReviewText', () => {
    it('redacts secrets and truncates long text', () => {
      const out = sanitizeReviewText('token sk-ant-api03-abcdefghij0123456789' + 'x'.repeat(MAX_BODY_LENGTH))
      expect(out).not.toContain('sk-ant-api03')
      expect(out).toContain('[REDACTED]')
      expect(out.length).toBeLessThanOrEqual(MAX_BODY_LENGTH + 16)
    })

    it('redacts a token that sits across the truncation boundary', () => {
      const token = 'sk-ant-api03-abcdefghij0123456789'
      const out = sanitizeReviewText('x'.repeat(MAX_BODY_LENGTH - 10) + token)
      expect(out).not.toContain('sk-ant-')
    })
  })

  describe('buildReviewCommentBody', () => {
    const base = {
      marker: REVIEW_MARKER,
      shortSha: 'abc1234',
      commitUrl: 'https://github.com/azumag/twica/commit/abc1234',
      runUrl: 'https://github.com/azumag/twica/actions/runs/12345',
    }

    it('includes marker, reviewed commit link and footer', () => {
      const body = buildReviewCommentBody({ ...base, safeText: '指摘なし' })
      expect(body.startsWith('<!-- claude-auto-review-preview -->\n## Claude Auto Review')).toBe(
        true,
      )
      expect(body).toContain(
        'Reviewed commit: [`abc1234`](https://github.com/azumag/twica/commit/abc1234)',
      )
      expect(body).toContain('指摘なし')
      expect(body).toContain(
        '*Generated by Claude Code (opus) · [Run](https://github.com/azumag/twica/actions/runs/12345)*',
      )
    })

    it('stays far below the issue comment limit even with max-length review text', () => {
      const body = buildReviewCommentBody({
        ...base,
        safeText: sanitizeReviewText('x'.repeat(MAX_BODY_LENGTH + 5000)),
      })
      expect(body.length).toBeLessThan(65536)
    })

    it('round-trips with findOwnReviewComment using the marker line', () => {
      const body = buildReviewCommentBody({ ...base, safeText: '指摘なし' })
      const comments = [{ user: { login: 'github-actions[bot]', type: 'Bot' }, body }]
      expect(findOwnReviewComment(comments, base.marker, 'github-actions[bot]')).toBeDefined()
    })
  })

  describe('parseReviewJson', () => {
    it('extracts a trimmed review string', () => {
      expect(parseReviewJson('{"review":"  指摘なし  "}')).toBe('指摘なし')
    })

    it('returns the trimmed value as-is (emptiness is validated by jq upstream)', () => {
      expect(parseReviewJson('{"review":""}')).toBe('')
      expect(parseReviewJson('{"review":"   "}')).toBe('')
    })

    it('throws for non-string or malformed inputs', () => {
      expect(() => parseReviewJson('{"review":123}')).toThrow()
      expect(() => parseReviewJson('{}')).toThrow()
      expect(() => parseReviewJson('null')).toThrow()
      expect(() => parseReviewJson('[]')).toThrow()
    })

    it('throws for invalid JSON', () => {
      expect(() => parseReviewJson('not json')).toThrow()
    })
  })

  describe('findOwnReviewComment', () => {
    const marker = REVIEW_MARKER

    it('finds the workflow-owned comment and ignores others', () => {
      const comments = [
        { user: { login: 'renovate[bot]', type: 'Bot' }, body: `${marker}\n...` },
        { user: { login: 'azumag', type: 'User' }, body: '普通のコメント' },
        {
          user: { login: 'github-actions[bot]', type: 'Bot' },
          body: `${marker}\n## Claude Auto Review`,
        },
      ]
      expect(findOwnReviewComment(comments, marker, 'github-actions[bot]')?.user?.login).toBe(
        'github-actions[bot]',
      )
    })

    it('returns undefined when no owned comment exists', () => {
      expect(findOwnReviewComment([], marker, 'github-actions[bot]')).toBeUndefined()
    })

    it('returns the latest owned comment when duplicates exist', () => {
      const comments = [
        { id: 1, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${marker}\n古い` },
        { id: 2, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `${marker}\n最新` },
      ]
      expect(findOwnReviewComment(comments, marker, 'github-actions[bot]')?.id).toBe(2)
    })

    it('accepts CRLF line endings and rejects first-line mismatches', () => {
      expect(
        findOwnReviewComment(
          [
            {
              user: { login: 'github-actions[bot]', type: 'Bot' },
              body: `${marker}\r\n## Claude Auto Review`,
            },
          ],
          marker,
          'github-actions[bot]',
        ),
      ).toBeDefined()
      expect(
        findOwnReviewComment(
          [
            {
              user: { login: 'github-actions[bot]', type: 'Bot' },
              body: `## Claude Auto Review\n${marker}`,
            },
          ],
          marker,
          'github-actions[bot]',
        ),
      ).toBeUndefined()
    })

    it('rejects other logins and missing body safely', () => {
      expect(
        findOwnReviewComment(
          [{ user: { login: 'renovate[bot]', type: 'Bot' }, body: `${marker}\n...` }],
          marker,
          'github-actions[bot]',
        ),
      ).toBeUndefined()
      expect(
        findOwnReviewComment([{ user: { login: 'github-actions[bot]' } }], marker, 'github-actions[bot]'),
      ).toBeUndefined()
      expect(findOwnReviewComment([undefined], marker, 'github-actions[bot]')).toBeUndefined()
    })
  })
})
