/**
 * #701 サブタスク4: analysis/src/lib/adminApi.ts の request() ハードニング
 * (タイムアウト/AbortSignal・構造化エラー)のテスト。
 *
 * adminApi.tsはimport.meta.envに依存しないブラウザ専用コードのため、
 * (他のanalysis/dev/*.tsと同じく)rootのvitestから直接importしてテストできる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminApi, AdminApiRequestError } from '../../analysis/src/lib/adminApi'

function fakeFetchResponse(init: { ok: boolean; status?: number; json?: unknown }) {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    json: async () => init.json,
  } as Response
}

describe('adminApi: request()のエラー構造化', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('エラーレスポンスはstatus/code/detailsを保持したAdminApiRequestErrorをthrowする', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeFetchResponse({
        ok: false,
        status: 503,
        json: { error: 'メンテナンス中です', code: 'maintenance_read_only', details: { retryAfter: 60 } },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(adminApi.getOverview()).rejects.toMatchObject({
      message: 'メンテナンス中です',
      status: 503,
      code: 'maintenance_read_only',
      details: { retryAfter: 60 },
    })
    await expect(adminApi.getOverview()).rejects.toBeInstanceOf(AdminApiRequestError)
  })

  it('JSON本文が無いエラーレスポンスでもstatusを含むフォールバックメッセージでthrowする', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(adminApi.getOverview()).rejects.toMatchObject({
      message: 'Admin API request failed: 500',
      status: 500,
      code: undefined,
    })
  })

  it('成功レスポンスはJSONをそのまま返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeFetchResponse({ ok: true, json: { stats: { totalUsers: 1 } } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const data = await adminApi.getOverview()
    expect(data).toEqual({ stats: { totalUsers: 1 } })
  })
})

describe('adminApi: request()のタイムアウト/AbortSignal', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('呼び出し元がsignalを渡さない場合は既定のAbortSignalが付与される', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeFetchResponse({ ok: true, json: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await adminApi.getUsers()

    const [, options] = fetchMock.mock.calls[0]
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('AbortSignal.timeout発火(name=TimeoutError)はcode:timeoutのAdminApiRequestErrorに正規化される', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('signal timed out', 'TimeoutError'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(adminApi.getUsers()).rejects.toMatchObject({
      code: 'timeout',
      status: 0,
    })
    await expect(adminApi.getUsers()).rejects.toBeInstanceOf(AdminApiRequestError)
  })

  it('呼び出し元の能動的なAbort(name=AbortError)は正規化せずそのまま伝播する', async () => {
    const abortError = new DOMException('The user aborted a request.', 'AbortError')
    const fetchMock = vi.fn().mockRejectedValue(abortError)
    vi.stubGlobal('fetch', fetchMock)

    await expect(adminApi.getUsers()).rejects.toBe(abortError)
  })
})
