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

    it('logs message with additional arguments', () => {
      logger.info('test message', 'arg1', { key: 'value' })
      expect(consoleLogMock).toHaveBeenCalledWith('[INFO] test message', 'arg1', { key: 'value' })
    })
  })

  describe('warn', () => {
    it('logs message with WARN prefix', () => {
      logger.warn('warning message')
      expect(consoleWarnMock).toHaveBeenCalledWith('[WARN] warning message')
    })

    it('logs message with error object', () => {
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

    it('logs message with multiple arguments', () => {
      logger.error('error message', 'context', { data: 'value' })
      expect(consoleErrorMock).toHaveBeenCalledWith('[ERROR] error message', 'context', { data: 'value' })
    })
  })
})
