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

// #701 UI state/UX: ページのuseEffectがAbortControllerでリクエストを能動的に
// キャンセルできるように、読み取り系メソッドは末尾にoptions?: RequestOptionsを
// 受け取り、渡されたsignalをrequest()へそのまま渡す(既定のタイムアウトsignalで
// 上書きしない)。読み取り系20メソッド全てを網羅的にテストする意味は薄いため、
// 引数の形が異なる代表2パターン(ページparams付き/既存params付き)のみ検証する
describe('adminApi: RequestOptionsによるsignal透過(#701 UI state/UX)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // request()は呼び出し元のsignalをそのまま使わず、既定タイムアウト用signalと
  // AbortSignal.anyで合成する(呼び出し元signalを渡してもタイムアウト保護を
  // 失わないようにするため)。そのため合成後のsignalへの参照同一性ではなく、
  // 呼び出し元のcontrollerをabortすると実際にfetchへ渡ったsignalも
  // abortされるという振る舞いで検証する(実装の内部詳細に依存しない)
  it('ページparams付きメソッド(getUsers)へ渡したsignalをabortするとfetchのsignalもabortされる', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeFetchResponse({ ok: true, json: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await adminApi.getUsers({ page: 1, pageSize: 20 }, { signal: controller.signal })

    const [, options] = fetchMock.mock.calls[0]
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.signal.aborted).toBe(false)
    controller.abort()
    expect(options.signal.aborted).toBe(true)
  })

  it('paramsを取るメソッド(getGachaSummary)も同様にsignalのabortが伝播する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeFetchResponse({ ok: true, json: { totalGacha: 0 } })
    )
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await adminApi.getGachaSummary({ range: 'all' }, { signal: controller.signal })

    const [, options] = fetchMock.mock.calls[0]
    controller.abort()
    expect(options.signal.aborted).toBe(true)
  })

  // #701 Fableレビュー High-1 の回帰確認: 呼び出し元がsignalを渡した場合に
  // 既定のタイムアウト保護(AbortSignal.timeout)が消えてしまわないことを検証する。
  // AbortSignal.anyの呼び出し引数を直接検証することで、「呼び出し元signalだけで
  // 単純に上書きする」実装への先祖返りを防ぐ
  it('呼び出し元がsignalを渡してもタイムアウト保護が失われない(AbortSignal.anyで合成)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeFetchResponse({ ok: true, json: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const anySpy = vi.spyOn(AbortSignal, 'any')
    const controller = new AbortController()

    await adminApi.getUsers({ page: 1, pageSize: 20 }, { signal: controller.signal })

    expect(anySpy).toHaveBeenCalledWith([controller.signal, expect.any(AbortSignal)])
    anySpy.mockRestore()
  })
})
