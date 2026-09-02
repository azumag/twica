import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger } from '@/lib/logger'

describe('logger', () => {
  let consoleLogMock: ReturnType<typeof vi.spyOn>
  let consoleWarnMock: ReturnType<typeof vi.spyOn>
  let consoleErrorMock: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogMock = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleWarnMock = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('info', () => {
    it('logs message with INFO prefix', () => {
      logger.info('test message')
      expect(consoleLogMock).toHaveBeenCalledWith('[INFO] test message')
    })

    it('passes through primitive arguments unchanged', () => {
      logger.info('test message', 'arg1', { key: 'value' })
      expect(consoleLogMock).toHaveBeenCalledWith('[INFO] test message', 'arg1', { key: 'value' })
    })
  })

  describe('warn', () => {
    it('logs message with WARN prefix', () => {
      logger.warn('warning message')
      expect(consoleWarnMock).toHaveBeenCalledWith('[WARN] warning message')
    })

    it('keeps Error shape while sanitizing Error arguments', () => {
      const error = new Error('test error')
      logger.warn('warning message', error)

      const loggedError = consoleWarnMock.mock.calls[0]?.[1]
      expect(loggedError).toBeInstanceOf(Error)
      expect(loggedError).not.toBe(error)
      expect((loggedError as Error).message).toBe('test error')
    })
  })

  describe('error', () => {
    it('logs message with ERROR prefix', () => {
      logger.error('error message')
      expect(consoleErrorMock).toHaveBeenCalledWith('[ERROR] error message')
    })

    it('passes string arguments through', () => {
      logger.error('error message', 'context')
      expect(consoleErrorMock).toHaveBeenCalledWith('[ERROR] error message', 'context')
    })
  })

  // Issue #401: console 経路にも同じマスキングポリシーを適用する。
  // Cloudflare Workers logs / wrangler tail に生のトークン等が出ないことを担保。
  describe('console-side sensitive masking (Issue #401)', () => {
    it('redacts token / cookie / session keys in info args', () => {
      logger.info('auth ok', {
        access_token: 'tk_secret',
        cookie: 'sid=abc',
        twitchUserId: '123',
      })
      expect(consoleLogMock).toHaveBeenCalledWith('[INFO] auth ok', {
        access_token: '[REDACTED]',
        cookie: '[REDACTED]',
        twitchUserId: '123',
      })
    })

    it('redacts sensitive keys in warn args without mutating original object', () => {
      const ctx = { refresh_token: 'rt_secret', endpoint: '/x' }
      logger.warn('refresh failed', ctx)
      expect(consoleWarnMock).toHaveBeenCalledWith('[WARN] refresh failed', {
        refresh_token: '[REDACTED]',
        endpoint: '/x',
      })
      // 入力オブジェクトの不変性: 呼び出し側の変数に副作用を残さない
      expect(ctx).toEqual({ refresh_token: 'rt_secret', endpoint: '/x' })
    })

    it('redacts nested sensitive keys in error args', () => {
      logger.error('db error', {
        operation: 'upsert',
        payload: { authorization: 'Bearer xyz', userId: 'u1' },
      })
      expect(consoleErrorMock).toHaveBeenCalledWith('[ERROR] db error', {
        operation: 'upsert',
        payload: { authorization: '[REDACTED]', userId: '[REDACTED]' },
      })
    })

    it('redacts Drizzle params embedded in the log message', () => {
      logger.error('query failed\nparams: secret-bind-value')
      expect(consoleErrorMock).toHaveBeenCalledWith('[ERROR] query failed\nparams: [REDACTED]')
    })

    it('preserves Error diagnostics while redacting Drizzle params', () => {
      const err = new Error('query failed\nparams: secret-bind-value')
      err.stack = 'Error: query failed\nparams: secret-bind-value\n    at test-callsite'

      logger.error('failure', err)

      const loggedError = consoleErrorMock.mock.calls[0]?.[1]
      expect(loggedError).toBeInstanceOf(Error)
      expect(loggedError).not.toBe(err)
      expect((loggedError as Error).message).toBe('query failed\nparams: [REDACTED]')
      expect((loggedError as Error).stack).toContain('params: [REDACTED]')
      expect((loggedError as Error).stack).toContain('at test-callsite')
      expect((loggedError as Error).stack).not.toContain('secret-bind-value')
    })
  })
})
