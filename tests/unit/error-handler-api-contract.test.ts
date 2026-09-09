import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { logErrorFromLoggerMock } = vi.hoisted(() => ({
  logErrorFromLoggerMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/sentry/error-handler', () => ({
  logErrorFromLogger: logErrorFromLoggerMock,
}))

import { ERROR_MESSAGES } from '@/lib/constants'
import { handleApiError } from '@/lib/error-handler'

/**
 * Issue #1352: route-level tests intentionally mock handleApiError and only pin
 * delegation at the API boundary. This suite fixes the complementary common
 * handler contract: an unclassified API exception is durably recorded before
 * returning the stable 500 response consumed by those routes.
 */
describe('handleApiError common 500 contract (#1352)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('records the original error/context and returns the stable internal-error response', async () => {
    const error = new Error('storage lookup failed')
    const additionalInfo = { operation: 'storage-status' }

    const response = await handleApiError(error, 'Storage Status API', additionalInfo)

    expect(logErrorFromLoggerMock).toHaveBeenCalledTimes(1)
    expect(logErrorFromLoggerMock).toHaveBeenCalledWith('Storage Status API:', [
      error,
      additionalInfo,
    ])
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: ERROR_MESSAGES.INTERNAL_ERROR })
  })
})
