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

  it('errorは共有console loggerへ出力後、server側だけでDB永続化を開始する', () => {
    const context = { operation: 'query', access_token: 'secret' }

    logger.error('database failed', context)

    // console側のredactionは共有logger、DB側のredactionはerror-handlerが担当する。
    // server logger自身で変形しないことで両実装の責務と既存契約を維持する。
    expect(consoleLogger.error).toHaveBeenCalledWith('database failed', context)
    expect(mockLogErrorFromLogger).toHaveBeenCalledWith('database failed', [context])
  })
})
