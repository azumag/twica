import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { guardWrite, guardWriteRedirect } from '@/lib/maintenance/guard'
import type { MaintenanceMode } from '@/lib/maintenance/state'
import { logger } from '@/lib/logger'

// db-retry.test.ts 等と同じパターン: logger.warn の副作用（console 出力）で
// テスト出力が汚れないようモック化する。「拒否時に operation 名を含めて呼ばれる」
// こと自体も下記の describe('logger 連携') で検証する（モック化は出力抑制目的だけではない）。
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const ALL_MAINTENANCE_ENV_KEYS = [
  'MAINTENANCE_MODE',
  'MAINTENANCE_STARTED_AT',
  'MAINTENANCE_EXPECTED_END_AT',
  'MAINTENANCE_MESSAGE_KEY',
  'MAINTENANCE_OPERATION_ID',
] as const

function stubMaintenanceEnv(overrides: Partial<Record<(typeof ALL_MAINTENANCE_ENV_KEYS)[number], string>> = {}) {
  for (const key of ALL_MAINTENANCE_ENV_KEYS) {
    vi.stubEnv(key, overrides[key])
  }
}

beforeEach(() => {
  // logger.warn の呼び出し履歴はテスト間で残るため、各テストの冒頭でクリアする
  // （db-retry.test.ts と同じパターン）。呼び出し検証を追加した際に前のテストの
  // 呼び出しを誤って拾ってしまう事故を防ぐ。
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('guardWrite / mode 別の許可・拒否マトリクス', () => {
  const NON_OFF_MODES: MaintenanceMode[] = [
    'read-only',
    'cutover-validating',
    'incident-read-only',
  ]

  it('mode=off なら常に null（許可）', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'off' })
    expect(guardWrite({ operation: 'test.op' })).toBeNull()
  })

  it('未設定（デフォルト off）でも null（許可）', () => {
    stubMaintenanceEnv()
    expect(guardWrite({ operation: 'test.op' })).toBeNull()
  })

  for (const mode of NON_OFF_MODES) {
    it(`mode=${mode} かつ allowDuring 未指定なら 503 で拒否する`, () => {
      stubMaintenanceEnv({ MAINTENANCE_MODE: mode })
      const response = guardWrite({ operation: 'test.op' })
      expect(response).not.toBeNull()
      expect(response!.status).toBe(503)
    })

    it(`mode=${mode} が allowDuring に含まれていれば null（許可）`, () => {
      stubMaintenanceEnv({ MAINTENANCE_MODE: mode })
      const response = guardWrite({ operation: 'test.op', allowDuring: [mode] })
      expect(response).toBeNull()
    })

    it(`mode=${mode} が allowDuring に含まれていなければ拒否する`, () => {
      stubMaintenanceEnv({ MAINTENANCE_MODE: mode })
      const otherModes = NON_OFF_MODES.filter((m) => m !== mode)
      const response = guardWrite({ operation: 'test.op', allowDuring: otherModes })
      expect(response).not.toBeNull()
      expect(response!.status).toBe(503)
    })
  }
})

describe('guardWrite / レスポンス body 形状', () => {
  it('read-only は maintenance_read_only を返す', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const response = guardWrite({ operation: 'test.op' })!
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'maintenance_read_only',
        message: expect.any(String),
        retryable: true,
      },
    })
  })

  it('cutover-validating は maintenance_cutover_validating を返す', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'cutover-validating' })
    const response = guardWrite({ operation: 'test.op' })!
    const body = await response.json()
    expect(body.error.code).toBe('maintenance_cutover_validating')
  })

  it('incident-read-only は maintenance_incident_read_only を返す', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'incident-read-only' })
    const response = guardWrite({ operation: 'test.op' })!
    const body = await response.json()
    expect(body.error.code).toBe('maintenance_incident_read_only')
  })

  it('expectedEndAt が設定されていればレスポンスに含む', async () => {
    stubMaintenanceEnv({
      MAINTENANCE_MODE: 'read-only',
      MAINTENANCE_EXPECTED_END_AT: '2026-07-16T01:00:00.000Z',
    })
    const response = guardWrite({ operation: 'test.op' })!
    const body = await response.json()
    expect(body.error.expectedEndAt).toBe('2026-07-16T01:00:00.000Z')
  })

  it('expectedEndAt が未設定ならレスポンスに含まない', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const response = guardWrite({ operation: 'test.op' })!
    const body = await response.json()
    expect(body.error).not.toHaveProperty('expectedEndAt')
  })

  it('retryable は常に true', async () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'incident-read-only' })
    const response = guardWrite({ operation: 'test.op' })!
    const body = await response.json()
    expect(body.error.retryable).toBe(true)
  })
})

describe('guardWrite / Retry-After ヘッダー', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
  })

  it('expectedEndAt が未来なら残り秒数を返す', () => {
    stubMaintenanceEnv({
      MAINTENANCE_MODE: 'read-only',
      MAINTENANCE_EXPECTED_END_AT: '2026-07-16T00:10:00.000Z', // 10分後
    })
    const response = guardWrite({ operation: 'test.op' })!
    expect(response.headers.get('Retry-After')).toBe('600')
  })

  it('expectedEndAt が過去なら 300 秒フォールバック（負値は出さない）', () => {
    stubMaintenanceEnv({
      MAINTENANCE_MODE: 'read-only',
      MAINTENANCE_EXPECTED_END_AT: '2026-07-15T00:00:00.000Z', // 1日前
    })
    const response = guardWrite({ operation: 'test.op' })!
    expect(response.headers.get('Retry-After')).toBe('300')
  })

  it('expectedEndAt が未設定なら 300 秒フォールバック', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const response = guardWrite({ operation: 'test.op' })!
    expect(response.headers.get('Retry-After')).toBe('300')
  })

  it('expectedEndAt がちょうど現在時刻なら remaining=0 となり 300 秒フォールバック（境界値）', () => {
    // computeRetryAfterSeconds は `remainingSeconds > 0` で判定するため、
    // remaining が正確に 0 の境界ケースもフォールバック側に倒れることを実測で確認する。
    stubMaintenanceEnv({
      MAINTENANCE_MODE: 'read-only',
      MAINTENANCE_EXPECTED_END_AT: '2026-07-16T00:00:00.000Z', // vi.setSystemTime と同時刻
    })
    const response = guardWrite({ operation: 'test.op' })!
    expect(response.headers.get('Retry-After')).toBe('300')
  })

  it('expectedEndAt が極端に遠い未来でも計算した残り秒数をそのまま返す（フォールバックしない）', () => {
    stubMaintenanceEnv({
      MAINTENANCE_MODE: 'read-only',
      MAINTENANCE_EXPECTED_END_AT: '2099-12-31T23:59:59.000Z',
    })
    const response = guardWrite({ operation: 'test.op' })!
    // 2026-07-16T00:00:00.000Z 〜 2099-12-31T23:59:59.000Z の Math.ceil((end-now)/1000)
    expect(response.headers.get('Retry-After')).toBe('2318284799')
  })
})

describe('guardWrite / Cache-Control ヘッダー', () => {
  it('拒否レスポンスには private, no-store を必ず設定する', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'incident-read-only' })
    const response = guardWrite({ operation: 'test.op' })!
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

describe('guardWriteRedirect', () => {
  it('mode=off なら null（許可）', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'off' })
    expect(
      guardWriteRedirect({ operation: 'auth.callback', redirectTo: '/?maintenance=1' })
    ).toBeNull()
  })

  it('mode=read-only なら 302 で redirectTo へリダイレクトする', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const response = guardWriteRedirect({
      operation: 'auth.callback',
      redirectTo: '/?maintenance=1',
    })!
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?maintenance=1')
  })

  it('mode=cutover-validating でも拒否する', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'cutover-validating' })
    const response = guardWriteRedirect({
      operation: 'auth.callback',
      redirectTo: '/?maintenance=1',
    })!
    expect(response.status).toBe(302)
  })

  it('mode=incident-read-only でも拒否する', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'incident-read-only' })
    const response = guardWriteRedirect({
      operation: 'auth.callback',
      redirectTo: '/?maintenance=1',
    })!
    expect(response.status).toBe(302)
  })

  it('拒否レスポンスには private, no-store を必ず設定する', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const response = guardWriteRedirect({
      operation: 'auth.callback',
      redirectTo: '/?maintenance=1',
    })!
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('絶対URL（プロトコル相対含む）は open redirect を防ぐため "/" へフォールバックする', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const cases = [
      'https://evil.example.com/',
      '//evil.example.com/',
      '/\\evil.example.com/',
    ]
    for (const redirectTo of cases) {
      const response = guardWriteRedirect({ operation: 'auth.callback', redirectTo })!
      expect(response.headers.get('Location')).toBe('/')
    }
  })

  it('制御文字・改行を含む値は "/" へフォールバックする（Location ヘッダーへの CRLF インジェクション対策）', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const response = guardWriteRedirect({
      operation: 'auth.callback',
      redirectTo: '/foo\r\nSet-Cookie: evil=1',
    })!
    expect(response.headers.get('Location')).toBe('/')
  })

  it('printable ASCII 以外（DEL・全角バックスラッシュ・日本語パス）は "/" へフォールバックする', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const cases = [
      // DEL (0x7f) はホワイトリスト範囲 0x21-0x7e の直後に位置し、境界の off-by-one を検出する
      '/\x7fevil.com',
      // 全角バックスラッシュ U+FF3C: 一部実装が半角 "\" 相当に正規化しうる非 ASCII 文字
      '/foo＼evil.com',
      // 日本語パス: 非 ASCII が「安全な相対パス」として素通りしないことの確認
      '/ダッシュボード設定',
    ]
    for (const redirectTo of cases) {
      const response = guardWriteRedirect({ operation: 'auth.callback', redirectTo })!
      expect(response.headers.get('Location')).toBe('/')
    }
  })

  it('通常の相対パス（クエリ・フラグメント含む）はそのまま使う', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    const response = guardWriteRedirect({
      operation: 'auth.callback',
      redirectTo: '/dashboard/settings?tab=twitch#top',
    })!
    expect(response.headers.get('Location')).toBe('/dashboard/settings?tab=twitch#top')
  })
})

describe('logger 連携', () => {
  it('guardWrite は拒否時に operation 名を含めて logger.warn を呼ぶ', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'read-only' })
    guardWrite({ operation: 'cards.collections.patch' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('cards.collections.patch')
  })

  it('guardWrite は許可時（mode=off）は logger.warn を呼ばない', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'off' })
    guardWrite({ operation: 'cards.collections.patch' })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('guardWriteRedirect は拒否時に operation 名を含めて logger.warn を呼ぶ', () => {
    stubMaintenanceEnv({ MAINTENANCE_MODE: 'incident-read-only' })
    guardWriteRedirect({ operation: 'auth.twitch.callback', redirectTo: '/?maintenance=1' })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain('auth.twitch.callback')
  })
})
