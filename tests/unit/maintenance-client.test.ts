import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseMaintenanceError,
  fetchMaintenanceStatus,
  resolveRetryAt,
} from '@/lib/maintenance/client'

function fakeResponse(status: number): Response {
  // parseMaintenanceError は response.status しか見ないため、実際に
  // Response.json() を呼べる必要はない（body は別引数で渡す設計のため）。
  return new Response(null, { status })
}

describe('parseMaintenanceError', () => {
  const MAINTENANCE_CODES = [
    'maintenance_read_only',
    'maintenance_cutover_validating',
    'maintenance_incident_read_only',
  ] as const

  for (const code of MAINTENANCE_CODES) {
    it(`503 + code=${code} は MaintenanceErrorInfo を返す`, () => {
      const body = {
        error: { code, message: 'メンテナンス中です', retryable: true },
      }
      const result = parseMaintenanceError(fakeResponse(503), body)
      expect(result).toEqual({
        code,
        message: 'メンテナンス中です',
        retryable: true,
      })
    })

    it(`503 + code=${code} + expectedEndAt ありなら expectedEndAt を含む`, () => {
      const body = {
        error: {
          code,
          message: 'メンテナンス中です',
          retryable: true,
          expectedEndAt: '2026-07-20T00:00:00.000Z',
        },
      }
      const result = parseMaintenanceError(fakeResponse(503), body)
      expect(result?.expectedEndAt).toBe('2026-07-20T00:00:00.000Z')
    })
  }

  it('非maintenance code の 503 は null（他の理由の503と混同しない）', () => {
    const body = { error: { code: 'rate_limited', message: 'too many requests', retryable: true } }
    expect(parseMaintenanceError(fakeResponse(503), body)).toBeNull()
  })

  it('status が 503 以外（200）は body に関わらず null', () => {
    const body = {
      error: { code: 'maintenance_read_only', message: 'x', retryable: true },
    }
    expect(parseMaintenanceError(fakeResponse(200), body)).toBeNull()
  })

  it('status が 503 以外（429）は null', () => {
    const body = {
      error: { code: 'maintenance_read_only', message: 'x', retryable: true },
    }
    expect(parseMaintenanceError(fakeResponse(429), body)).toBeNull()
  })

  it('status が 503 以外（500）は null', () => {
    const body = {
      error: { code: 'maintenance_read_only', message: 'x', retryable: true },
    }
    expect(parseMaintenanceError(fakeResponse(500), body)).toBeNull()
  })

  it('body 未指定（省略）は null', () => {
    expect(parseMaintenanceError(fakeResponse(503))).toBeNull()
  })

  it('body が null は null', () => {
    expect(parseMaintenanceError(fakeResponse(503), null)).toBeNull()
  })

  it('body が object でない（文字列）場合は null', () => {
    expect(parseMaintenanceError(fakeResponse(503), 'not json')).toBeNull()
  })

  it('error フィールドが無い body は null', () => {
    expect(parseMaintenanceError(fakeResponse(503), {})).toBeNull()
  })

  it('error.code が欠落している場合は null', () => {
    const body = { error: { message: 'x', retryable: true } }
    expect(parseMaintenanceError(fakeResponse(503), body)).toBeNull()
  })

  it('error.message が文字列でない場合は null', () => {
    const body = { error: { code: 'maintenance_read_only', message: 123, retryable: true } }
    expect(parseMaintenanceError(fakeResponse(503), body)).toBeNull()
  })

  it('error.retryable が boolean でない場合は安全側の false に倒す（例外にしない）', () => {
    const body = { error: { code: 'maintenance_read_only', message: 'x', retryable: 'yes' } }
    const result = parseMaintenanceError(fakeResponse(503), body)
    expect(result?.retryable).toBe(false)
  })

  it('error.expectedEndAt が文字列でない場合は結果に含めない', () => {
    const body = {
      error: { code: 'maintenance_read_only', message: 'x', retryable: true, expectedEndAt: 12345 },
    }
    const result = parseMaintenanceError(fakeResponse(503), body)
    expect(result).not.toHaveProperty('expectedEndAt')
  })
})

describe('fetchMaintenanceStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mode=off のみのレスポンスをそのまま返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mode: 'off' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMaintenanceStatus()).resolves.toEqual({ mode: 'off' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/maintenance-status',
      expect.objectContaining({ cache: 'no-store' })
    )
  })

  it('mode/expectedEndAt/publicMessageKey を全て含むレスポンスをそのまま返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          mode: 'incident-read-only',
          expectedEndAt: '2026-07-20T00:00:00.000Z',
          publicMessageKey: 'incident',
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMaintenanceStatus()).resolves.toEqual({
      mode: 'incident-read-only',
      expectedEndAt: '2026-07-20T00:00:00.000Z',
      publicMessageKey: 'incident',
    })
  })

  it('非200応答は fail-safe に { mode: "off" } を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMaintenanceStatus()).resolves.toEqual({ mode: 'off' })
  })

  it('fetch が例外を投げても fail-safe に { mode: "off" } を返す（例外を外へ漏らさない）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMaintenanceStatus()).resolves.toEqual({ mode: 'off' })
  })

  it('不正な JSON（パース不能）でも fail-safe に { mode: "off" } を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMaintenanceStatus()).resolves.toEqual({ mode: 'off' })
  })

  it('mode が既知の値でない場合は off にフォールバックする', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ mode: 'not-a-real-mode' }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMaintenanceStatus()).resolves.toEqual({ mode: 'off' })
  })
})

describe('resolveRetryAt', () => {
  const NOW = Date.parse('2026-07-16T00:00:00.000Z')

  it('expectedEndAt が未来なら優先してその Date を返す', () => {
    const result = resolveRetryAt(
      { expectedEndAt: '2026-07-16T00:10:00.000Z', retryAfterHeader: '300' },
      NOW
    )
    expect(result).toEqual(new Date('2026-07-16T00:10:00.000Z'))
  })

  it('expectedEndAt が過去なら Retry-After ヘッダーにフォールバックする', () => {
    const result = resolveRetryAt(
      { expectedEndAt: '2026-07-15T00:00:00.000Z', retryAfterHeader: '600' },
      NOW
    )
    expect(result).toEqual(new Date(NOW + 600 * 1000))
  })

  it('expectedEndAt が不正な文字列なら Retry-After ヘッダーにフォールバックする', () => {
    const result = resolveRetryAt(
      { expectedEndAt: 'not-a-date', retryAfterHeader: '120' },
      NOW
    )
    expect(result).toEqual(new Date(NOW + 120 * 1000))
  })

  it('expectedEndAt が無く Retry-After ヘッダーのみなら秒数から Date を計算する', () => {
    const result = resolveRetryAt({ retryAfterHeader: '60' }, NOW)
    expect(result).toEqual(new Date(NOW + 60 * 1000))
  })

  it('両方とも無ければ null', () => {
    expect(resolveRetryAt({}, NOW)).toBeNull()
  })

  it('Retry-After ヘッダーが数値でない文字列なら null', () => {
    expect(resolveRetryAt({ retryAfterHeader: 'not-a-number' }, NOW)).toBeNull()
  })

  it('Retry-After ヘッダーが負の値なら null（不正値として扱う）', () => {
    expect(resolveRetryAt({ retryAfterHeader: '-10' }, NOW)).toBeNull()
  })

  it('Retry-After ヘッダーが "0" なら現在時刻ちょうどの Date を返す（境界値）', () => {
    const result = resolveRetryAt({ retryAfterHeader: '0' }, NOW)
    expect(result).toEqual(new Date(NOW))
  })

  it('now を省略すると Date.now() を基準に計算する', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
    const result = resolveRetryAt({ retryAfterHeader: '30' })
    expect(result).toEqual(new Date('2026-07-16T00:00:30.000Z'))
    vi.useRealTimers()
  })
})
