import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock のfactoryは静的importより先へ巻き上げられるため、通常のconstを参照すると
// Temporal Dead Zoneで初期化前アクセスになる。fixture自体もvi.hoisted内で生成し、
// mock factoryとテスト本体が同じ初期化済み参照を共有する。
const { consoleLogger, mockLogErrorFromLogger } = vi.hoisted(() => ({
  consoleLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockLogErrorFromLogger: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/logger', () => ({ logger: consoleLogger }))
vi.mock('@/lib/sentry/error-handler', () => ({
  logErrorFromLogger: mockLogErrorFromLogger,
}))

import { logger } from '@/lib/logger.server'

describe('server-only logger boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('info/warnは共有console loggerへ委譲し、DB永続化を増やさない', () => {
    logger.info('info', { requestId: 'r1' })
    logger.warn('warn', { requestId: 'r2' })

    expect(consoleLogger.info).toHaveBeenCalledWith('info', { requestId: 'r1' })
    expect(consoleLogger.warn).toHaveBeenCalledWith('warn', { requestId: 'r2' })
    expect(mockLogErrorFromLogger).not.toHaveBeenCalled()
  })

  it('errorはconsole委譲後、サニタイズ済みargsだけをDB永続化へ渡す', () => {
    const context = { operation: 'query', access_token: 'secret' }

    logger.error('database failed', context)

    // console側のredactionは共有loggerに委譲するため、server境界ではraw引数をそのまま渡す。
    expect(consoleLogger.error).toHaveBeenCalledWith('database failed', context)
    // DB永続化側は共有sanitizerを先に通し、raw secretをerror-handlerへ渡さない。
    expect(mockLogErrorFromLogger).toHaveBeenCalledWith('database failed', [
      { operation: 'query', access_token: '[REDACTED]' },
    ])
  })

  it('Drizzle-style Errorのmessage / stack / paramsをDB永続化前に検閲する', () => {
    const dbError = Object.assign(
      new Error('Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value'),
      { params: ['sensitive-token-value'] },
    )
    dbError.name = 'DrizzleQueryError'
    dbError.stack = 'DrizzleQueryError: Failed query: UPDATE users SET twitch_access_token = $1\nparams: sensitive-token-value\n    at query.ts:1:1'

    logger.error('token save failed', dbError)

    expect(consoleLogger.error).toHaveBeenCalledWith('token save failed', dbError)
    const persisted = mockLogErrorFromLogger.mock.calls[0][1][0] as Error & { params: unknown }
    expect(persisted).toBeInstanceOf(Error)
    expect(persisted.message).toContain('params: [REDACTED]')
    expect(persisted.message).not.toContain('sensitive-token-value')
    expect(persisted.stack).toContain('params: [REDACTED]')
    expect(persisted.stack).not.toContain('sensitive-token-value')
    expect(persisted.params).toBe('[REDACTED]')
  })
})
