import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/maintenance-status/route'

const ALL_MAINTENANCE_ENV_KEYS = [
  'MAINTENANCE_MODE',
  'MAINTENANCE_STARTED_AT',
  'MAINTENANCE_EXPECTED_END_AT',
  'MAINTENANCE_MESSAGE_KEY',
  'MAINTENANCE_OPERATION_ID',
] as const

// maintenance-guard.test.ts と同じパターン: 全 maintenance 系 env を一括で
// スタブ/リセットするヘルパー。個別テストで指定しなかったキーは undefined
// にスタブされ、他テストからの汚染を防ぐ。
function stubMaintenanceEnv(
  overrides: Partial<Record<(typeof ALL_MAINTENANCE_ENV_KEYS)[number], string>> = {}
) {
  for (const key of ALL_MAINTENANCE_ENV_KEYS) {
    vi.stubEnv(key, overrides[key])
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/maintenance-status', () => {
  beforeEach(() => {
    stubMaintenanceEnv()
  })

  it('mode=off（未設定）なら { mode: "off" } のみを返す', async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ mode: 'off' })
  })

  it('mode=read-only かつ expectedEndAt/publicMessageKey 設定時はその3フィールドを返す', async () => {
    stubMaintenanceEnv({
      MAINTENANCE_MODE: 'read-only',
      MAINTENANCE_EXPECTED_END_AT: '2026-07-20T00:00:00.000Z',
      MAINTENANCE_MESSAGE_KEY: 'planned',
    })
    const response = await GET()
    await expect(response.json()).resolves.toEqual({
      mode: 'read-only',
      expectedEndAt: '2026-07-20T00:00:00.000Z',
      publicMessageKey: 'planned',
    })
  })

  it('mode=cutover-validating を返す', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'cutover-validating' })
    const response = await GET()
    await expect(response.json()).resolves.toEqual({ mode: 'cutover-validating' })
  })

  it('mode=incident-read-only を返す', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'incident-read-only' })
    const response = await GET()
    await expect(response.json()).resolves.toEqual({ mode: 'incident-read-only' })
  })

  it('不正な MAINTENANCE_MODE は off にフォールバックする（getMaintenanceState の既定動作）', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'not-a-real-mode' })
    const response = await GET()
    await expect(response.json()).resolves.toEqual({ mode: 'off' })
  })

  it('機密情報（startedAt / operationId）を絶対に含まない', async () => {
    stubMaintenanceEnv({
      MAINTENANCE_MODE: 'incident-read-only',
      MAINTENANCE_STARTED_AT: '2026-07-16T00:00:00.000Z',
      MAINTENANCE_OPERATION_ID: 'incident-1234-internal',
      MAINTENANCE_EXPECTED_END_AT: '2026-07-16T02:00:00.000Z',
      MAINTENANCE_MESSAGE_KEY: 'incident',
    })
    const response = await GET()
    const body = await response.json()

    expect(body).not.toHaveProperty('startedAt')
    expect(body).not.toHaveProperty('operationId')
    // 意図しないキー混入がないことも確認する（3フィールドちょうど）
    expect(Object.keys(body).sort()).toEqual(
      ['expectedEndAt', 'mode', 'publicMessageKey'].sort()
    )
  })

  it('Cache-Control: private, no-store を必ず設定する', async () => {
    const response = await GET()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('mode=off でも Cache-Control は同様に設定される', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'off' })
    const response = await GET()
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
