import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getKvBinding } from '@/lib/cloudflare-kv'

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}))

describe('getKvBinding', () => {
  beforeEach(() => {
    mocks.getCloudflareContext.mockReset()
    mocks.loggerWarn.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('RATE_LIMIT_KV bindingをasync Cloudflare contextから返す', async () => {
    const binding = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    }
    mocks.getCloudflareContext.mockResolvedValue({
      env: { RATE_LIMIT_KV: binding },
    })

    await expect(getKvBinding()).resolves.toBe(binding)
    expect(mocks.getCloudflareContext).toHaveBeenCalledTimes(1)
    expect(mocks.getCloudflareContext).toHaveBeenCalledWith({ async: true })
  })

  it('RATE_LIMIT_KV bindingが無い場合はnullを返す', async () => {
    mocks.getCloudflareContext.mockResolvedValue({ env: {} })

    await expect(getKvBinding()).resolves.toBeNull()
  })

  it('Cloudflare contextを解決できない場合もnullへfallbackする', async () => {
    mocks.getCloudflareContext.mockRejectedValue(new Error('context unavailable'))

    await expect(getKvBinding()).resolves.toBeNull()
    expect(mocks.loggerWarn).not.toHaveBeenCalled()
  })

  it('productionでCloudflare context解決に失敗した場合はfallback前に警告する', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    mocks.getCloudflareContext.mockRejectedValue(new Error('context unavailable'))

    await expect(getKvBinding()).resolves.toBeNull()
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '[cloudflare-kv] RATE_LIMIT_KV binding resolution failed; using fallback',
      { error: 'context unavailable' },
    )
  })
})
