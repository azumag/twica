import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

describe('middleware overlay events validation', () => {
  it('不正なstreamerIdを400の固定JSON本文で拒否する', async () => {
    const response = await middleware(
      new NextRequest('https://example.com/api/overlay/not-a-uuid/events')
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid streamer ID',
    })
  })
})
