import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

describe('middleware overlay events validation', () => {
  // Regression contract from #1320/#1322: keep this early 400 body stable across
  // middleware/proxy refactors instead of letting unrelated work silently rewrite it.
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
