import { describe, expect, it } from 'vitest'
import { parseArgs, resolveConfig } from '../../scripts/storage-maintenance.mjs'

describe('scripts/storage-maintenance.mjs (#1907)', () => {
  const env = { STORAGE_MAINTENANCE_SECRET: 'secret' }

  it('既知のフラグを解釈する（collect は既定 dry-run）', () => {
    const parsed = parseArgs([
      'node',
      'script',
      '--url=https://app.example.test',
      '--action=collect-unused-sounds',
      '--min-age-seconds=3600',
      '--max-deletions=10',
      '--max-objects=100',
    ])

    expect(parsed.error).toBeUndefined()
    expect(parsed.execute).toBe(false)
    expect(parsed.action).toBe('collect-unused-sounds')
    expect(parsed.minAgeSeconds).toBe(3600)
    expect(parsed.maxDeletions).toBe(10)
    expect(parsed.maxObjects).toBe(100)
  })

  it('未知のフラグを黙って無視しない（typo で既定削除に化けるのを防ぐ）', () => {
    const parsed = parseArgs([
      'node',
      'script',
      '--url=https://app.example.test',
      '--max-deletion=10', // typo
    ])

    expect(parsed.error).toContain('不明な引数')
  })

  it('https 必須（localhost のみ http を許可）', () => {
    expect(
      resolveConfig(
        parseArgs(['node', 'script', '--url=http://app.example.test']),
        env,
      ),
    ).toEqual({ error: expect.stringContaining('https://') })

    expect(
      resolveConfig(
        parseArgs(['node', 'script', '--url=http://localhost:3000']),
        env,
      ),
    ).toMatchObject({ url: 'http://localhost:3000', action: 'reconcile' })

    expect(
      resolveConfig(
        parseArgs(['node', 'script', '--url=https://app.example.test/']),
        env,
      ),
    ).toMatchObject({ url: 'https://app.example.test', secret: 'secret' })
  })

  it('secret 未設定・不正な action を拒否する', () => {
    expect(
      resolveConfig(
        parseArgs(['node', 'script', '--url=https://app.example.test']),
        {},
      ),
    ).toEqual({ error: expect.stringContaining('STORAGE_MAINTENANCE_SECRET') })

    expect(
      resolveConfig(
        parseArgs(['node', 'script', '--url=https://app.example.test', '--action=drop']),
        env,
      ),
    ).toEqual({ error: expect.stringContaining('--action') })
  })
})
