import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
}))

vi.mock('@/lib/logger.server', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/db/client', () => ({
  getDb: vi.fn(async () => ({ db: dbMock, sql: vi.fn() })),
}))
vi.mock('@/lib/db/retry', () => ({
  withDbRetry: async (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('@/lib/storage-db', () => ({
  reconcileStorageUsage: vi.fn(),
  removeBlobFile: vi.fn(),
}))
vi.mock('@/lib/r2-client', () => ({
  getR2PublicUrl: vi.fn(() => 'https://images.example.com'),
  getR2SoundPublicUrl: vi.fn(() => 'https://sound.example.com'),
  listSoundObjects: vi.fn(),
  deleteSoundFromR2: vi.fn(),
}))

import {
  collectReferencedSoundKeys,
  collectUnusedSoundObjects,
  runStorageUsageReconciliation,
} from '@/lib/storage-maintenance'
import { reconcileStorageUsage, removeBlobFile } from '@/lib/storage-db'
import { deleteSoundFromR2, listSoundObjects } from '@/lib/r2-client'
import { streamers as streamersTable } from '@/lib/db/schema'

const mockReconcile = vi.mocked(reconcileStorageUsage)
const mockRemoveBlobFile = vi.mocked(removeBlobFile)
const mockListSoundObjects = vi.mocked(listSoundObjects)
const mockDeleteSound = vi.mocked(deleteSoundFromR2)

function primeSelects(
  streamerRows: Array<{ url: string | null; rules: unknown }>,
  ledgerRows: Array<{ url: string }> = [],
): void {
  dbMock.select.mockImplementation(() => ({
    from: vi.fn((table: unknown) => {
      const rows = table === streamersTable ? streamerRows : ledgerRows
      const builder = {
        where: vi.fn(() => Promise.resolve(rows)),
        then: (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(onFulfilled, onRejected),
      }
      return builder
    }),
  }))
}

function primeStreamers(rows: Array<{ url: string | null; rules: unknown }>): void {
  primeSelects(rows)
}

describe('storage-maintenance (#1907)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    primeStreamers([])
    mockListSoundObjects.mockResolvedValue({ objects: [], truncated: false })
    mockRemoveBlobFile.mockResolvedValue(null)
    mockDeleteSound.mockResolvedValue(undefined)
    mockReconcile.mockResolvedValue([])
  })

  describe('collectReferencedSoundKeys', () => {
    it('gacha_sound_url と gacha_sound_rules の url をキーとして集約する', async () => {
      primeStreamers([
        {
          url: 'https://sound.example.com/sound_legacy.wav',
          rules: [
            { url: 'https://sound.example.com/sound_rule1.wav', enabled: false },
            { url: 'https://external.example.com/not-a-sound-object.mp3' },
            { url: null },
            'invalid',
          ],
        },
        { url: null, rules: null },
      ])

      const keys = await collectReferencedSoundKeys()

      expect(keys).toEqual(new Set(['sound_legacy.wav', 'sound_rule1.wav']))
    })

    it('ホストが変わっていても R2 キーが同じなら参照済みとして扱う（fail-safe）', async () => {
      primeStreamers([
        { url: 'https://old-sound-domain.example.com/sound_keep.wav', rules: [] },
      ])

      const keys = await collectReferencedSoundKeys()

      expect(keys.has('sound_keep.wav')).toBe(true)
    })

    it('rules が JSON 文字列として返っても配列へ復元する', async () => {
      primeStreamers([
        {
          url: null,
          rules: JSON.stringify([{ url: 'https://sound.example.com/sound_json.wav' }]),
        },
      ])

      const keys = await collectReferencedSoundKeys()

      expect(keys.has('sound_json.wav')).toBe(true)
    })

    it('配列以外の rules は誤削除を避けるため throw する', async () => {
      primeStreamers([{ url: null, rules: { url: 'https://sound.example.com/sound_obj.wav' } }])

      await expect(collectReferencedSoundKeys()).rejects.toThrow(/Unexpected gacha_sound_rules shape/)
    })

    it('壊れた rules 文字列は誤削除を避けるため throw する', async () => {
      primeStreamers([{ url: null, rules: '{not-json' }])

      await expect(collectReferencedSoundKeys()).rejects.toThrow(/Invalid gacha_sound_rules/)
    })
  })

  describe('collectUnusedSoundObjects', () => {
    const now = Date.now()
    const oldUploaded = new Date(now - 2 * 24 * 60 * 60 * 1000)
    const newUploaded = new Date(now - 60 * 60 * 1000)

    function primeObjects(): void {
      primeStreamers([
        { url: 'https://sound.example.com/sound_referenced.wav', rules: [] },
      ])
      mockListSoundObjects.mockResolvedValue({
        objects: [
          { key: 'sound_referenced.wav', size: 10, uploaded: oldUploaded },
          { key: 'sound_old.wav', size: 20, uploaded: oldUploaded },
          { key: 'sound_new.wav', size: 30, uploaded: newUploaded },
          { key: 'sound_unknown.wav', size: 40, uploaded: null },
        ],
        truncated: false,
      })
    }

    it('参照済み・新しすぎる・年齢不明を除外し、古い未使用だけを R2→台帳の順で回収する', async () => {
      primeObjects()
      mockRemoveBlobFile.mockResolvedValue({
        userPrefix: 'prefix12',
        fileSize: 20,
        storageType: 'r2',
      })

      const result = await collectUnusedSoundObjects()

      expect(result.scannedObjects).toBe(4)
      expect(result.referencedObjects).toBe(1)
      expect(result.skippedTooNew).toBe(1)
      expect(result.skippedUnknownAge).toBe(1)
      expect(result.candidateCount).toBe(1)
      expect(result.candidateKeys).toEqual(['sound_old.wav'])
      expect(result.deleted).toBe(1)
      expect(result.ledgerRemoved).toBe(1)
      expect(mockDeleteSound).toHaveBeenCalledWith('sound_old.wav')
      expect(mockRemoveBlobFile).toHaveBeenCalledWith('https://sound.example.com/sound_old.wav')
    })

    it('dryRun は候補だけ返し、R2 も台帳も変更しない', async () => {
      primeObjects()

      const result = await collectUnusedSoundObjects({ dryRun: true })

      expect(result.dryRun).toBe(true)
      expect(result.candidateKeys).toEqual(['sound_old.wav'])
      expect(result.deleted).toBe(0)
      expect(mockDeleteSound).not.toHaveBeenCalled()
      expect(mockRemoveBlobFile).not.toHaveBeenCalled()
    })

    it('R2 削除に失敗した場合は台帳を減算しない（残存オブジェクトを未計上にしない）', async () => {
      primeObjects()
      mockDeleteSound.mockRejectedValue(new Error('r2 down'))

      const result = await collectUnusedSoundObjects()

      expect(result.deleted).toBe(0)
      expect(result.r2DeleteFailed).toBe(1)
      expect(mockRemoveBlobFile).not.toHaveBeenCalled()
    })

    it('台帳減算だけが失敗した場合も件数を返して処理を継続する', async () => {
      primeObjects()
      mockDeleteSound.mockResolvedValue(undefined)
      mockRemoveBlobFile.mockRejectedValue(new Error('db down'))

      const result = await collectUnusedSoundObjects()

      expect(result.deleted).toBe(1)
      expect(result.ledgerRemoveFailed).toBe(1)
    })

    it('minAgeSeconds と maxDeletions を尊重する', async () => {
      primeStreamers([])
      mockListSoundObjects.mockResolvedValue({
        objects: [
          { key: 'sound_a.wav', size: 1, uploaded: new Date(now - 10_000) },
          { key: 'sound_b.wav', size: 1, uploaded: new Date(now - 9_000) },
          { key: 'sound_c.wav', size: 1, uploaded: new Date(now - 8_000) },
        ],
        truncated: true,
      })

      const result = await collectUnusedSoundObjects({
        minAgeSeconds: 5,
        maxDeletions: 2,
        dryRun: true,
      })

      expect(result.candidateCount).toBe(3)
      expect(result.candidateKeys).toEqual(['sound_a.wav', 'sound_b.wav'])
      expect(result.listTruncated).toBe(true)
    })

    it('台帳に保存された旧ドメイン URL を使い、再構築 URL で取りこぼさない', async () => {
      primeSelects([], [{ url: 'https://old-sound-domain.example.com/sound_old.wav' }])
      mockListSoundObjects.mockResolvedValue({
        objects: [{ key: 'sound_old.wav', size: 10, uploaded: oldUploaded }],
        truncated: false,
      })
      mockRemoveBlobFile.mockResolvedValue({
        userPrefix: 'prefix12',
        fileSize: 10,
        storageType: 'r2',
      })

      const result = await collectUnusedSoundObjects()

      expect(mockRemoveBlobFile).toHaveBeenCalledWith(
        'https://old-sound-domain.example.com/sound_old.wav',
      )
      expect(result.ledgerRemoved).toBe(1)
    })

    it('R2 に無い台帳行は一覧が完全なときに再照合で削除する', async () => {
      primeSelects([], [{ url: 'https://sound.example.com/sound_stale.wav' }])
      mockListSoundObjects.mockResolvedValue({ objects: [], truncated: false })
      mockRemoveBlobFile.mockResolvedValue({
        userPrefix: 'prefix12',
        fileSize: 10,
        storageType: 'r2',
      })

      const result = await collectUnusedSoundObjects()

      expect(mockRemoveBlobFile).toHaveBeenCalledWith(
        'https://sound.example.com/sound_stale.wav',
      )
      expect(result.ledgerReconciled).toBe(1)
    })

    it('台帳削除の一時失敗は同じ実行内で再試行する', async () => {
      primeSelects([], [{ url: 'https://sound.example.com/sound_old.wav' }])
      mockListSoundObjects.mockResolvedValue({
        objects: [{ key: 'sound_old.wav', size: 10, uploaded: oldUploaded }],
        truncated: false,
      })
      mockRemoveBlobFile
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({
          userPrefix: 'prefix12',
          fileSize: 10,
          storageType: 'r2',
        })

      const result = await collectUnusedSoundObjects()

      expect(mockRemoveBlobFile).toHaveBeenCalledTimes(2)
      expect(result.ledgerReconciled).toBe(1)
      expect(result.ledgerRemoveFailed).toBe(0)
    })

    it('年齢が Invalid Date のオブジェクトは削除しない', async () => {
      primeStreamers([])
      mockListSoundObjects.mockResolvedValue({
        objects: [{ key: 'sound_invalid.wav', size: 10, uploaded: new Date(NaN) }],
        truncated: false,
      })

      const result = await collectUnusedSoundObjects()

      expect(result.skippedUnknownAge).toBe(1)
      expect(mockDeleteSound).not.toHaveBeenCalled()
    })

    it('不正なオプションは削除前に拒否する', async () => {
      await expect(collectUnusedSoundObjects({ minAgeSeconds: -1 })).rejects.toThrow(/minAgeSeconds/)
      await expect(collectUnusedSoundObjects({ maxDeletions: 0 })).rejects.toThrow(/maxDeletions/)
      await expect(collectUnusedSoundObjects({ maxObjects: 0 })).rejects.toThrow(/maxObjects/)
      expect(mockDeleteSound).not.toHaveBeenCalled()
    })
  })

  describe('runStorageUsageReconciliation', () => {
    it('差分件数を返し、0 件でも成功する', async () => {
      mockReconcile.mockResolvedValue([
        {
          userPrefix: 'prefix12',
          previousBytes: 10,
          actualBytes: 20,
          previousCount: 1,
          actualCount: 2,
        },
      ])

      await expect(runStorageUsageReconciliation()).resolves.toMatchObject({ changed: 1 })

      mockReconcile.mockResolvedValue([])
      await expect(runStorageUsageReconciliation()).resolves.toEqual({ changed: 0, diffs: [] })
    })
  })
})
