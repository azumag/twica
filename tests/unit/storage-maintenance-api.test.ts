import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/storage-maintenance', () => ({
  runStorageUsageReconciliation: vi.fn(),
  collectUnusedSoundObjects: vi.fn(),
  MAX_UNUSED_SOUND_DELETIONS: 200,
  MAX_UNUSED_SOUND_MAX_OBJECTS: 50_000,
}))

import { POST } from '@/app/api/internal/storage-maintenance/route'
import {
  collectUnusedSoundObjects,
  runStorageUsageReconciliation,
} from '@/lib/storage-maintenance'

const mockReconcile = vi.mocked(runStorageUsageReconciliation)
const mockCollect = vi.mocked(collectUnusedSoundObjects)
const SECRET = 'test-storage-maintenance-secret'

function makeRequest(body: unknown, secret: string | null = SECRET, rawBody?: string): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (secret !== null) headers.set('x-storage-maintenance-secret', secret)
  return new NextRequest('http://localhost:3000/api/internal/storage-maintenance', {
    method: 'POST',
    headers,
    body: rawBody ?? JSON.stringify(body),
  })
}

describe('POST /api/internal/storage-maintenance (#1907)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STORAGE_MAINTENANCE_SECRET = SECRET
    mockReconcile.mockResolvedValue({ changed: 0, diffs: [] })
    mockCollect.mockResolvedValue({
      dryRun: false,
      scannedObjects: 0,
      referencedObjects: 0,
      skippedUnknownAge: 0,
      skippedTooNew: 0,
      candidateCount: 0,
      candidateKeys: [],
      deleted: 0,
      ledgerRemoved: 0,
      ledgerMissing: 0,
      r2DeleteFailed: 0,
      ledgerReconciled: 0,
      ledgerRemoveFailed: 0,
      ledgerReconcileFailed: 0,
      listTruncated: false,
    })
  })

  afterEach(() => {
    delete process.env.STORAGE_MAINTENANCE_SECRET
  })

  it('シークレット未設定は fail-closed で500', async () => {
    delete process.env.STORAGE_MAINTENANCE_SECRET
    const response = await POST(makeRequest({ action: 'reconcile' }))

    expect(response.status).toBe(500)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('シークレット不一致は403', async () => {
    const response = await POST(makeRequest({ action: 'reconcile' }, 'wrong'))

    expect(response.status).toBe(403)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('reconcile を実行して差分を返す', async () => {
    mockReconcile.mockResolvedValue({
      changed: 1,
      diffs: [
        {
          userPrefix: 'prefix12',
          previousBytes: 10,
          actualBytes: 20,
          previousCount: 1,
          actualCount: 2,
        },
      ],
    })

    const response = await POST(makeRequest({ action: 'reconcile' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.action).toBe('reconcile')
    expect(body.changed).toBe(1)
    expect(body.diffs).toHaveLength(1)
  })

  it('collect-unused-sounds に検証済みオプションだけを渡す', async () => {
    const response = await POST(
      makeRequest({
        action: 'collect-unused-sounds',
        dryRun: true,
        minAgeSeconds: 3600,
        maxDeletions: 10,
        maxObjects: 100,
      }),
    )

    expect(response.status).toBe(200)
    expect(mockCollect).toHaveBeenCalledWith({
      dryRun: true,
      minAgeSeconds: 3600,
      maxDeletions: 10,
      maxObjects: 100,
    })
  })

  it.each([
    ['未知の action', { action: 'drop-everything' }],
    ['未知のフィールド', { action: 'reconcile', force: true }],
    ['minAgeSeconds=0', { action: 'collect-unused-sounds', minAgeSeconds: 0 }],
    ['負の maxDeletions', { action: 'collect-unused-sounds', maxDeletions: -1 }],
    ['maxDeletions の上限超過', { action: 'collect-unused-sounds', maxDeletions: 201 }],
    ['maxObjects の上限超過', { action: 'collect-unused-sounds', maxObjects: 50001 }],
    ['dryRun の型違反', { action: 'collect-unused-sounds', dryRun: 'yes' }],
  ])('%s は400', async (_label, body) => {
    const response = await POST(makeRequest(body))

    expect(response.status).toBe(400)
    expect(mockReconcile).not.toHaveBeenCalled()
    expect(mockCollect).not.toHaveBeenCalled()
  })

  it('不正な JSON は400', async () => {
    const response = await POST(makeRequest(null, SECRET, '{'))

    expect(response.status).toBe(400)
  })

  it('ジョブ失敗は500（成功扱いにしない）', async () => {
    mockReconcile.mockRejectedValue(new Error('db down'))

    const response = await POST(makeRequest({ action: 'reconcile' }))

    expect(response.status).toBe(500)
  })
})
