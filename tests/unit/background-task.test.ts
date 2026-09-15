import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runInBackground } from '@/lib/background-task'

const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

vi.mock('@/lib/logger.server', () => ({
  logger: {
    warn: mocks.warn,
  },
}))

describe('runInBackground', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Cloudflare contextでは同じtaskをwaitUntilへ登録してtask完了を待たずに返す', async () => {
    const waitUntil = vi.fn()
    mocks.getCloudflareContext.mockResolvedValue({ ctx: { waitUntil } })
    let resolveTask!: () => void
    const task = new Promise<void>((resolve) => {
      resolveTask = resolve
    })

    await runInBackground('publish', task)

    expect(mocks.getCloudflareContext).toHaveBeenCalledWith({ async: true })
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(waitUntil).toHaveBeenCalledWith(task)
    expect(mocks.warn).not.toHaveBeenCalled()

    resolveTask()
    await task
  })

  it('Cloudflare contextが無い場合はwarningを残してtask完了まで待つ', async () => {
    mocks.getCloudflareContext.mockRejectedValue(new Error('context unavailable'))
    let resolveTask!: () => void
    const task = new Promise<void>((resolve) => {
      resolveTask = resolve
    })
    let completed = false
    const running = runInBackground('fallback-test', task).then(() => {
      completed = true
    })

    await vi.waitFor(() => {
      expect(mocks.warn).toHaveBeenCalledWith(
        '[background-task] waitUntil unavailable (fallback-test), falling back to sync',
        { error: 'context unavailable' },
      )
    })
    expect(completed).toBe(false)

    resolveTask()
    await running
    expect(completed).toBe(true)
  })
})
