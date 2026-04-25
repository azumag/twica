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

    it('passes Error instances through untouched', () => {
      const error = new Error('test error')
      logger.warn('warning message', error)
      expect(consoleWarnMock).toHaveBeenCalledWith('[WARN] warning message', error)
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

    it('keeps Error instances untouched so stack traces remain available', () => {
      const err = new Error('boom')
      logger.error('failure', err)
      expect(consoleErrorMock).toHaveBeenCalledWith('[ERROR] failure', err)
    })
  })
})
