import { describe, it, expect } from 'vitest'
import {
  isSensitiveKey,
  sanitizeContext,
  sanitizeLogArg,
  extractErrorMessage,
} from '@/lib/log-sanitizer'

// Issue #401: console / Supabase / GitHub Issue の3経路で同じマスキングポリシーを
// 適用するため、ロジックをこのモジュールに集約している。ここではポリシーの
// 不変条件（partial vs exact match の境界、再帰、不変性、フォールバック）を検証する。
describe('log-sanitizer', () => {
  describe('isSensitiveKey', () => {
    it.each([
      'password',
      'PASSWORD',
      'twitch_access_token',
      'refresh_token',
      'authorization',
      'cookie',
      'csrf_token',
      'client_secret',
      'apikey',
      'api_key',
      'session_id',
      'sessionid',
    ])('redacts partial match key %s', (key) => {
      expect(isSensitiveKey(key)).toBe(true)
    })

    it.each(['userId', 'username', 'email', 'ip_address', 'params'])(
      'redacts exact match key %s',
      (key) => {
        expect(isSensitiveKey(key)).toBe(true)
      }
    )

    it.each(['broadcasterUserId', 'twitchUsername', 'streamerId', 'safeName', 'queryParams'])(
      'keeps debug-friendly compound key %s',
      (key) => {
        expect(isSensitiveKey(key)).toBe(false)
      }
    )
  })

  describe('sanitizeContext', () => {
    it('does not mutate the input object', () => {
      const original = { token: 'sec', safe: 'ok' }
      const cloned = { ...original }
      sanitizeContext(original)
      expect(original).toEqual(cloned)
    })

    it('redacts nested sensitive keys', () => {
      expect(
        sanitizeContext({ outer: { token: 't', safe: 's' } })
      ).toEqual({ outer: { token: '[REDACTED]', safe: 's' } })
    })

    it('sanitizes objects inside arrays', () => {
      expect(
        sanitizeContext({ items: [{ password: 'p' }, { name: 'n' }] })
      ).toEqual({ items: [{ password: '[REDACTED]' }, { name: 'n' }] })
    })

    it('redacts Drizzle-style bind params stored as a context string', () => {
      expect(sanitizeContext({
        error: 'Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value',
      })).toEqual({
        error: 'Failed query: UPDATE users SET twitch_access_token = $1\nparams: [REDACTED]',
      })
    })

    it('preserves a nested Error while redacting its message / stack / params', () => {
      const dbError = Object.assign(
        new Error('Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value'),
        {
          query: 'UPDATE users SET twitch_access_token = $1',
          params: ['sensitive-token-value'],
          cause: { code: '42703' },
        },
      )
      dbError.name = 'DrizzleQueryError'
      dbError.stack = 'DrizzleQueryError: Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value\n    at query.ts:1:1'

      const sanitized = sanitizeContext({ twitchUserId: 'user-1', error: dbError })
      const nested = sanitized.error as Error & {
        query: string
        params: unknown
        cause: { code: string }
      }

      expect(sanitized.twitchUserId).toBe('user-1')
      expect(nested).toBeInstanceOf(Error)
      expect(nested.message).toContain('params: [REDACTED]')
      expect(nested.message).not.toContain('sensitive-token-value')
      expect(nested.stack).toContain('params: [REDACTED]')
      expect(nested.stack).toContain('at query.ts:1:1')
      expect(nested.params).toBe('[REDACTED]')
      expect(nested.query).toBe('UPDATE users SET twitch_access_token = $1')
      expect(nested.cause).toEqual({ code: '42703' })
    })
  })

  describe('sanitizeLogArg', () => {
    it('redacts sensitive keys in plain records', () => {
      expect(sanitizeLogArg({ token: 't', x: 1 })).toEqual({
        token: '[REDACTED]',
        x: 1,
      })
    })

    it('sanitizes Error message / stack and enumerable params without mutating the original', () => {
      const err = Object.assign(
        new Error('Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value'),
        {
          query: 'UPDATE users SET twitch_access_token = $1',
          params: ['sensitive-token-value'],
        },
      )
      err.name = 'DrizzleQueryError'
      err.stack = 'DrizzleQueryError: Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value\n    at query.ts:1:1'

      const out = sanitizeLogArg(err) as Error & { query: string; params: unknown }

      expect(out).toBeInstanceOf(Error)
      expect(out).not.toBe(err)
      expect(out.name).toBe('DrizzleQueryError')
      expect(out.message).toContain('params: [REDACTED]')
      expect(out.message).not.toContain('sensitive-token-value')
      expect(out.stack).toContain('params: [REDACTED]')
      expect(out.stack).toContain('at query.ts:1:1')
      expect(out.stack).not.toContain('sensitive-token-value')
      expect(out.query).toBe('UPDATE users SET twitch_access_token = $1')
      expect(out.params).toBe('[REDACTED]')
      expect(err.message).toContain('sensitive-token-value')
    })

    it.each([null, undefined, 42, 'plain', true])(
      'passes primitive %s through unchanged',
      (val) => {
        expect(sanitizeLogArg(val)).toBe(val)
      }
    )

    it('sanitizes objects inside top-level arrays', () => {
      expect(sanitizeLogArg([{ token: 't' }, 'safe'])).toEqual([
        { token: '[REDACTED]' },
        'safe',
      ])
    })
  })

  describe('extractErrorMessage', () => {
    it('returns the message string from PostgrestError-like objects', () => {
      expect(
        extractErrorMessage({ code: '23505', message: 'duplicate key' })
      ).toBe('duplicate key')
    })

    it('redacts Drizzle-style params from message fields', () => {
      expect(extractErrorMessage({
        message: 'Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value',
      })).toBe('Failed query: UPDATE users SET twitch_access_token = $1\nparams: [REDACTED]')
    })

    it('falls back to JSON.stringify with redacted secrets when message is missing', () => {
      const out = extractErrorMessage({ code: 500, token: 'secret' })
      expect(out).toContain('"code":500')
      expect(out).toContain('[REDACTED]')
      expect(out).not.toContain('secret')
    })

    it('handles circular references safely', () => {
      const circular: Record<string, unknown> = { name: 'x' }
      circular.self = circular
      const out = extractErrorMessage(circular)
      expect(out).toContain('"name":"x"')
      expect(out).toContain('[Circular]')
    })

    it('stringifies primitives via String()', () => {
      expect(extractErrorMessage(null)).toBe('null')
      expect(extractErrorMessage(undefined)).toBe('undefined')
      expect(extractErrorMessage(42)).toBe('42')
    })
  })
})
