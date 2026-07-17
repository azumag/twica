import { describe, it, expect, vi, afterEach } from 'vitest'
import { getMaintenanceState } from '@/lib/maintenance/state'

// tests/unit/db-flags.test.ts と同じパターン: 環境変数は vi.stubEnv で設定し
// afterEach の vi.unstubAllEnvs で確実に復元する。process.env への直接 mutation は
// テスト失敗時に復元されず他テストへ漏れる構造的リスクがあるため使わない。
afterEach(() => {
  vi.unstubAllEnvs()
})

function stubAllMaintenanceEnv(overrides: Record<string, string | undefined> = {}) {
  const keys = [
    'MAINTENANCE_MODE',
    'MAINTENANCE_STARTED_AT',
    'MAINTENANCE_EXPECTED_END_AT',
    'MAINTENANCE_MESSAGE_KEY',
    'MAINTENANCE_OPERATION_ID',
  ]
  for (const key of keys) {
    vi.stubEnv(key, overrides[key])
  }
}

describe('getMaintenanceState / mode 解決', () => {
  it('全て未設定なら mode は off で他フィールドは undefined', () => {
    stubAllMaintenanceEnv()
    expect(getMaintenanceState()).toEqual({
      mode: 'off',
      startedAt: undefined,
      expectedEndAt: undefined,
      publicMessageKey: undefined,
      operationId: undefined,
    })
  })

  it('MAINTENANCE_MODE=off を返す', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: 'off' })
    expect(getMaintenanceState().mode).toBe('off')
  })

  it('MAINTENANCE_MODE=read-only を返す', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    expect(getMaintenanceState().mode).toBe('read-only')
  })

  it('MAINTENANCE_MODE=cutover-validating を返す', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: 'cutover-validating' })
    expect(getMaintenanceState().mode).toBe('cutover-validating')
  })

  it('MAINTENANCE_MODE=incident-read-only を返す', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: 'incident-read-only' })
    expect(getMaintenanceState().mode).toBe('incident-read-only')
  })

  it('不正値は off に倒す（誤設定でサービス全体を止めない）', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: 'read-onlyy' })
    expect(getMaintenanceState().mode).toBe('off')
  })

  it('空文字は off に倒す', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: '' })
    expect(getMaintenanceState().mode).toBe('off')
  })

  it('前後の空白・改行は無視される（wrangler secret put の混入対策）', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: ' read-only\n' })
    expect(getMaintenanceState().mode).toBe('read-only')

    stubAllMaintenanceEnv({ MAINTENANCE_MODE: '\tincident-read-only ' })
    expect(getMaintenanceState().mode).toBe('incident-read-only')
  })

  it('呼び出しのたびに process.env を読む（モジュールキャッシュしない）', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: undefined })
    expect(getMaintenanceState().mode).toBe('off')
    // OpenNext の populateProcessEnv のように「後から」env が注入されても反映される
    stubAllMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    expect(getMaintenanceState().mode).toBe('read-only')
  })
})

describe('getMaintenanceState / startedAt・expectedEndAt', () => {
  it('妥当な ISO 8601 文字列はそのまま返す', () => {
    stubAllMaintenanceEnv({
      MAINTENANCE_STARTED_AT: '2026-07-16T00:00:00.000Z',
      MAINTENANCE_EXPECTED_END_AT: '2026-07-16T01:00:00.000Z',
    })
    const state = getMaintenanceState()
    expect(state.startedAt).toBe('2026-07-16T00:00:00.000Z')
    expect(state.expectedEndAt).toBe('2026-07-16T01:00:00.000Z')
  })

  it('前後の空白はトリムして保持する', () => {
    stubAllMaintenanceEnv({
      MAINTENANCE_STARTED_AT: '  2026-07-16T00:00:00.000Z\n',
    })
    expect(getMaintenanceState().startedAt).toBe('2026-07-16T00:00:00.000Z')
  })

  it('Date.parse できない不正値は undefined になる（絶対に throw しない）', () => {
    stubAllMaintenanceEnv({
      MAINTENANCE_STARTED_AT: 'not-a-date',
      MAINTENANCE_EXPECTED_END_AT: 'also-not-a-date',
    })
    expect(() => getMaintenanceState()).not.toThrow()
    const state = getMaintenanceState()
    expect(state.startedAt).toBeUndefined()
    expect(state.expectedEndAt).toBeUndefined()
  })

  it('未設定・空文字は undefined になる', () => {
    stubAllMaintenanceEnv({ MAINTENANCE_STARTED_AT: '' })
    expect(getMaintenanceState().startedAt).toBeUndefined()
  })
})

describe('getMaintenanceState / publicMessageKey・operationId', () => {
  it('設定値をトリムして返す', () => {
    stubAllMaintenanceEnv({
      MAINTENANCE_MESSAGE_KEY: '  maintenance.readOnly \n',
      MAINTENANCE_OPERATION_ID: '\top-20260716-01 ',
    })
    const state = getMaintenanceState()
    expect(state.publicMessageKey).toBe('maintenance.readOnly')
    expect(state.operationId).toBe('op-20260716-01')
  })

  it('未設定・空文字・空白のみは undefined になる', () => {
    stubAllMaintenanceEnv({
      MAINTENANCE_MESSAGE_KEY: '   ',
      MAINTENANCE_OPERATION_ID: undefined,
    })
    const state = getMaintenanceState()
    expect(state.publicMessageKey).toBeUndefined()
    expect(state.operationId).toBeUndefined()
  })
})
