/**
 * #700（#574 / #568 Phase 1-5）analysis ダッシュボード admin backend の
 * pg 直結切替（overview / leaderboard / users / streamers / gacha summary）のテスト。
 *
 * `tests/unit/db-flags.test.ts`（フラグのデフォルト・trim・不正値の扱い）と
 * `tests/unit/storage-db-driver-parity.test.ts`（フラグ未設定時に旧経路のみが
 * 呼ばれることの回帰確認）の2パターンを踏襲する。
 *
 * `analysis/` は root とは別 npm パッケージ（独自 node_modules）のため、root の
 * `tests/unit/` から `vi.mock('postgres', ...)` を当てても、
 * `analysis/dev/adminApiPg.ts` が実際に解決する `analysis/node_modules/postgres`
 * （root とは別の物理パッケージ）には効かない。そのため postgres.js クライアント
 * 生成は `__setAnalysisSqlFactoryForTests`（テスト専用の注入フック）で差し替える。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** モジュール状態（sqlClient シングルトン・注入フック）をテストごとにリセットして import する */
async function importAdminApiPg() {
  return await import('../../analysis/dev/adminApiPg')
}

async function importLocalAdminApi() {
  return await import('../../analysis/dev/localAdminApi')
}

// getOverview() 等が期待する SupabaseClient<Database> 型は analysis/ 自身の
// @supabase/supabase-js（root とは別物理パッケージ、../../analysis/node_modules 配下）
// から解決される。root の tests/unit/ から `SupabaseClient` 型を import すると
// クラスの protected メンバー起因でクロスパッケージの型不一致エラーになるため
// （postgres.js と同じ「別npmパッケージの独自 node_modules」問題）、ここでは
// rpc() だけを実装する最小限の fake を any で渡す（.rpc() しか呼ばれない経路のみ検証対象）。
function fakeRpcClient(result: unknown): any {
  return {
    rpc: vi.fn().mockResolvedValue({ data: result, error: null }),
  }
}

/**
 * query()に渡されたSQLテンプレート文字列を集約して返す fake sql タグ関数。
 * postgres.js のタグ付きテンプレート呼び出し（strings, ...values）を模すため
 * 可変長引数を受ける（getGachaSummaryPg のようにバインド値を持つ呼び出しもある）
 */
function fakeSqlTag(result: unknown) {
  const calls: string[][] = []
  const tag = vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<{ result: unknown }[]>>(
    (strings) => {
      calls.push(Array.from(strings))
      return Promise.resolve([{ result }])
    }
  )
  return { tag, calls }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getAnalysisDbDriver', () => {
  it('未設定なら supabase（既存動作がデフォルト）', async () => {
    const { getAnalysisDbDriver } = await importAdminApiPg()
    expect(getAnalysisDbDriver({})).toBe('supabase')
  })

  it('ANALYSIS_DB_DRIVER=pg を返す', async () => {
    const { getAnalysisDbDriver } = await importAdminApiPg()
    expect(getAnalysisDbDriver({ ANALYSIS_DB_DRIVER: 'pg' })).toBe('pg')
  })

  it('不正値は supabase に倒す', async () => {
    const { getAnalysisDbDriver } = await importAdminApiPg()
    expect(getAnalysisDbDriver({ ANALYSIS_DB_DRIVER: 'mysql' })).toBe('supabase')
  })

  it('前後の空白・改行は無視される', async () => {
    const { getAnalysisDbDriver } = await importAdminApiPg()
    expect(getAnalysisDbDriver({ ANALYSIS_DB_DRIVER: ' pg\n' })).toBe('pg')
  })
})

describe('adminApiPg: pg直結クエリ', () => {
  it('DASHBOARD_DATABASE_URL 未設定なら明示的に throw する（注入フック未使用時）', async () => {
    const { getOverviewPg } = await importAdminApiPg()
    await expect(getOverviewPg({})).rejects.toThrow('DASHBOARD_DATABASE_URL')
  })

  it('getOverviewPg: get_analysis_overview() を呼び result 列を返す', async () => {
    const { tag, calls } = fakeSqlTag({ stats: { totalUsers: 3 } })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getOverviewPg({})

    expect(data).toEqual({ stats: { totalUsers: 3 } })
    expect(calls[0].join('')).toContain('get_analysis_overview()')
  })

  it('getStreamerLeaderboardPg: get_analysis_streamer_leaderboard() を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ streamerId: 's1', drawCount: 5 }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getStreamerLeaderboardPg({})

    expect(data).toEqual([{ streamerId: 's1', drawCount: 5 }])
    expect(calls[0].join('')).toContain('get_analysis_streamer_leaderboard()')
  })

  it('listUsersPg: get_analysis_users() を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'u1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listUsersPg({})

    expect(data).toEqual([{ id: 'u1' }])
    expect(calls[0].join('')).toContain('get_analysis_users()')
  })

  it('listStreamersWithStatsPg: get_analysis_streamers() を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'st1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listStreamersWithStatsPg({})

    expect(data).toEqual([{ id: 'st1' }])
    expect(calls[0].join('')).toContain('get_analysis_streamers()')
  })

  // 5関数とも callAnalysisJsonFunction() を共有しているため、エラー伝播の検証は
  // 代表として getOverviewPg 1件で行う（5関数分の重複は無意味な繰り返しになるため）。
  it('sql クエリが reject したら呼び出し元にそのまま伝播する', async () => {
    const failure = new Error('connection refused')
    const tag = vi.fn().mockRejectedValue(failure)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await expect(mod.getOverviewPg({})).rejects.toThrow('connection refused')
  })

  // getGachaSummaryPg は唯一引数を取る関数なので、バインドパラメータとして
  // 正しく渡っていることを個別に検証する（他4関数と違い表形式に混ぜない）
  it('getGachaSummaryPg: get_analysis_gacha_summary(p_from_date, p_streamer_id) を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag({ totalGacha: 42 })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getGachaSummaryPg(
      {},
      { fromDate: '2024-01-01T00:00:00.000Z', streamerId: 'streamer-1' }
    )

    expect(data).toEqual({ totalGacha: 42 })
    expect(calls[0].join('')).toContain('get_analysis_gacha_summary(')
    // タグ関数呼び出し全体の第2・第3引数がバインドされた値そのもの（文字列連結ではない）
    expect(tag.mock.calls[0][1]).toBe('2024-01-01T00:00:00.000Z')
    expect(tag.mock.calls[0][2]).toBe('streamer-1')
  })

  it('getGachaSummaryPg: streamerId 省略時は null をバインドする', async () => {
    const { tag } = fakeSqlTag({ totalGacha: 0 })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await mod.getGachaSummaryPg({}, { fromDate: null, streamerId: null })

    expect(tag.mock.calls[0][1]).toBeNull()
    expect(tag.mock.calls[0][2]).toBeNull()
  })
})

// 移植済み4関数（getOverview/getStreamerLeaderboard/listUsers/listStreamersWithStats）
// はいずれも同じ「先頭1行の分岐」パターンなので、4関数まとめて表形式で回帰確認する
// （tests/unit/storage-db-driver-parity.test.ts と同じく全関数を漏れなく検証する）
const ROUTED_ENDPOINTS = [
  {
    name: 'getOverview',
    rpcName: 'get_analysis_overview',
    supabaseResult: { stats: { totalUsers: 1 } },
    pgResult: { stats: { totalUsers: 9 } },
    call: async (client: unknown, env: Record<string, string>) => {
      const { getOverview } = await importLocalAdminApi()
      return getOverview(client as never, env)
    },
  },
  {
    name: 'getStreamerLeaderboard',
    rpcName: 'get_analysis_streamer_leaderboard',
    supabaseResult: [{ streamerId: 'legacy' }],
    pgResult: [{ streamerId: 's1', drawCount: 5 }],
    call: async (client: unknown, env: Record<string, string>) => {
      const { getStreamerLeaderboard } = await importLocalAdminApi()
      return getStreamerLeaderboard(client as never, env)
    },
  },
  {
    name: 'listUsers',
    rpcName: 'get_analysis_users',
    supabaseResult: [{ id: 'legacy' }],
    pgResult: [{ id: 'u1' }],
    call: async (client: unknown, env: Record<string, string>) => {
      const { listUsers } = await importLocalAdminApi()
      return listUsers(client as never, env)
    },
  },
  {
    name: 'listStreamersWithStats',
    rpcName: 'get_analysis_streamers',
    supabaseResult: [{ id: 'legacy' }],
    pgResult: [{ id: 'st1' }],
    call: async (client: unknown, env: Record<string, string>) => {
      const { listStreamersWithStats } = await importLocalAdminApi()
      return listStreamersWithStats(client as never, env)
    },
  },
] as const

describe.each(ROUTED_ENDPOINTS)(
  'localAdminApi: $name の ANALYSIS_DB_DRIVER による経路切替（回帰確認）',
  ({ rpcName, supabaseResult, pgResult, call }) => {
    it('未設定なら Supabase RPC 経路のみを呼び、pg 経路には触れない', async () => {
      const client = fakeRpcClient(supabaseResult)

      const data = await call(client, {})

      expect(data).toEqual(supabaseResult)
      expect(client.rpc).toHaveBeenCalledWith(rpcName)
    })

    it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
      const { tag } = fakeSqlTag(pgResult)
      const adminApiPg = await importAdminApiPg()
      adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
      const client = fakeRpcClient(supabaseResult)

      const data = await call(client, { ANALYSIS_DB_DRIVER: 'pg' })

      expect(data).toEqual(pgResult)
      expect(client.rpc).not.toHaveBeenCalled()
    })
  }
)

// getGachaSummary は他4関数と違い tryJsonbRpc() を経由せず client.rpc() を直接
// 2引数(関数名 + パラメータオブジェクト)で呼ぶため、表形式のROUTED_ENDPOINTSには
// 混ぜず個別に検証する
describe('localAdminApi: getGachaSummary の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase RPC 経路のみを呼び、pg 経路には触れない', async () => {
    const client = fakeRpcClient({ totalGacha: 1 })
    const { getGachaSummary } = await importLocalAdminApi()

    const data = await getGachaSummary(client, { range: 'all', streamerId: 'streamer-1' }, {})

    expect(data).toEqual({ totalGacha: 1 })
    expect(client.rpc).toHaveBeenCalledWith('get_analysis_gacha_summary', {
      p_from_date: null,
      p_streamer_id: 'streamer-1',
    })
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag({ totalGacha: 9 })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeRpcClient({ totalGacha: 1 })
    const { getGachaSummary } = await importLocalAdminApi()

    const data = await getGachaSummary(
      client,
      { range: 'all', streamerId: 'streamer-1' },
      { ANALYSIS_DB_DRIVER: 'pg' }
    )

    expect(data).toEqual({ totalGacha: 9 })
    expect(client.rpc).not.toHaveBeenCalled()
    expect(tag.mock.calls[0][2]).toBe('streamer-1')
  })

  // streamerId未指定（全配信者対象、ダッシュボード既定表示で最も多いケース）は
  // analysis/src/pages/Gacha.tsx から `streamerId: undefined` で渡ってくる。
  // postgres.js はタグ付きテンプレートに undefined が渡ると
  // UNDEFINED_VALUE エラーで即throwするため（transform.undefined未設定時の既定挙動）、
  // getGachaSummary() 内の `params.streamerId ?? null` によるnull変換が必須。
  // この変換が将来のリファクタで失われても検出できるよう、undefined入力を明示的に検証する
  it('ANALYSIS_DB_DRIVER=pg かつ streamerId 未指定でも UNDEFINED_VALUE エラーにならない', async () => {
    const { tag } = fakeSqlTag({ totalGacha: 3 })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeRpcClient({ totalGacha: 1 })
    const { getGachaSummary } = await importLocalAdminApi()

    const data = await getGachaSummary(
      client,
      { range: 'all', streamerId: undefined },
      { ANALYSIS_DB_DRIVER: 'pg' }
    )

    expect(data).toEqual({ totalGacha: 3 })
    expect(tag.mock.calls[0][2]).toBeNull()
  })
})
