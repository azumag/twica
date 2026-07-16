/**
 * #700（#574 / #568 Phase 1-5）analysis ダッシュボード admin backend の
 * pg 直結切替（overview / leaderboard / users / streamers / gacha summary /
 * gacha chart・table・export）のテスト。
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
// rpc()/from() だけを実装する最小限の fake を any で渡す。
function fakeRpcClient(result: unknown): any {
  return {
    rpc: vi.fn().mockResolvedValue({ data: result, error: null }),
    from: vi.fn(),
  }
}

// getGachaChart/getGachaTable/getGachaExportRows の Supabase 経路（default モード）
// が使う `.from().select().order()...` チェーンの最小限のスタブ。
// storage-db-driver-parity.test.ts の builder パターンを踏襲する。
// count は getGachaTable の `{ count: 'exact' }` 用。
function fakeQueryBuilderClient(resolved: { data: unknown; count?: number; error?: unknown }): any {
  const builder: any = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    ilike: vi.fn(() => builder),
    range: vi.fn(() => builder),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({
        data: resolved.data,
        count: resolved.count ?? null,
        error: resolved.error ?? null,
      }).then(onFulfilled, onRejected),
  }
  const from = vi.fn(() => builder)
  return { from, rpc: vi.fn(), builder }
}

/**
 * postgres.js のタグ付きテンプレート呼び出し（fragment合成含む）を模す fake sql。
 *
 * gachaHistoryFromWhere() 等は `sql`` を `${}` でネストしてWHERE句を動的に組み立てる
 * （postgres.js の「fragment合成」機能、README「nesting sql`` fragments」参照）。
 * この fake は、ネストされた fragment を実際に await されるまで解決しない thenable
 * として表現し、最終的に await された時点で全フラグメントを1本のテキスト＋
 * バインド値配列に平坦化して calls に記録する（＝実際にDBへ発行される最終クエリの
 * 形を模す）。fragment合成のない単純な呼び出し（getOverviewPg等）でも、
 * calls には従来どおり1件だけ記録される。
 *
 * count は `count(*)` を含むクエリ（getGachaTablePg の件数クエリ）専用の戻り値。
 * 未指定時は result と同じ値を使う（count(*)を使わない関数のテストでは無関係なため）。
 */
interface FakeFragment {
  __fakeFragment: true
  strings: readonly string[]
  values: unknown[]
}

function isFakeFragment(value: unknown): value is FakeFragment {
  return !!value && typeof value === 'object' && (value as FakeFragment).__fakeFragment === true
}

function flattenFragment(
  strings: readonly string[],
  values: readonly unknown[]
): { text: string; values: unknown[] } {
  let text = strings[0]
  const flatValues: unknown[] = []
  values.forEach((value, index) => {
    if (isFakeFragment(value)) {
      const inner = flattenFragment(value.strings, value.values)
      text += inner.text
      flatValues.push(...inner.values)
    } else {
      flatValues.push(value)
    }
    text += strings[index + 1]
  })
  return { text, values: flatValues }
}

function fakeSqlTag(result: unknown, count: unknown = result) {
  const calls: { text: string; values: unknown[] }[] = []

  const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment: FakeFragment & PromiseLike<unknown> = {
      __fakeFragment: true,
      strings,
      values,
      then(onFulfilled, onRejected) {
        const flattened = flattenFragment(strings, values)
        calls.push(flattened)
        const rows = flattened.text.includes('count(*)') ? [{ count }] : [{ result }]
        return Promise.resolve(rows).then(onFulfilled as never, onRejected as never)
      },
    }
    return fragment
  })

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
    expect(calls[0].text).toContain('get_analysis_overview()')
  })

  it('getStreamerLeaderboardPg: get_analysis_streamer_leaderboard() を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ streamerId: 's1', drawCount: 5 }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getStreamerLeaderboardPg({})

    expect(data).toEqual([{ streamerId: 's1', drawCount: 5 }])
    expect(calls[0].text).toContain('get_analysis_streamer_leaderboard()')
  })

  it('listUsersPg: get_analysis_users() を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'u1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listUsersPg({})

    expect(data).toEqual([{ id: 'u1' }])
    expect(calls[0].text).toContain('get_analysis_users()')
  })

  it('listStreamersWithStatsPg: get_analysis_streamers() を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'st1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listStreamersWithStatsPg({})

    expect(data).toEqual([{ id: 'st1' }])
    expect(calls[0].text).toContain('get_analysis_streamers()')
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
    expect(calls[0].text).toContain('get_analysis_gacha_summary(')
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

describe('adminApiPg: gachaHistoryFromWhere（動的WHERE句の組み立て）', () => {
  it('フィルタなしなら WHERE TRUE のみ（絞り込み条件は付かない）', async () => {
    const { tag, calls } = fakeSqlTag(null)
    const mod = await importAdminApiPg()

    await mod.gachaHistoryFromWhere(tag as never, {})

    expect(calls[0].text).toContain('FROM gacha_history gh')
    expect(calls[0].text).toContain('JOIN cards c ON c.id = gh.card_id')
    expect(calls[0].text).toContain('JOIN streamers s ON s.id = gh.streamer_id')
    expect(calls[0].text).toContain('WHERE TRUE')
    expect(calls[0].text).not.toContain('AND')
    expect(calls[0].values).toEqual([])
  })

  it('streamerId のみ指定: gh.streamer_id 条件だけが追加される', async () => {
    const { tag, calls } = fakeSqlTag(null)
    const mod = await importAdminApiPg()

    await mod.gachaHistoryFromWhere(tag as never, { streamerId: 'streamer-1' })

    expect(calls[0].text).toContain('AND gh.streamer_id = ')
    expect(calls[0].text).not.toContain('AND gh.redeemed_at')
    expect(calls[0].text).not.toContain('AND gh.user_twitch_username')
    expect(calls[0].text).not.toContain('AND c.rarity')
    expect(calls[0].values).toEqual(['streamer-1'])
  })

  it('全フィルタ指定: 5条件すべてがこの順序でバインドされる', async () => {
    const { tag, calls } = fakeSqlTag(null)
    const mod = await importAdminApiPg()

    await mod.gachaHistoryFromWhere(tag as never, {
      streamerId: 'streamer-1',
      fromDate: '2024-01-01T00:00:00Z',
      toDateExclusive: '2024-02-01T00:00:00Z',
      usernameIlike: '%alice%',
      rarity: 'legendary',
    })

    expect(calls[0].values).toEqual([
      'streamer-1',
      '2024-01-01T00:00:00Z',
      '2024-02-01T00:00:00Z',
      '%alice%',
      'legendary',
    ])
    expect(calls[0].text).toContain('AND gh.streamer_id = ')
    expect(calls[0].text).toContain('AND gh.redeemed_at >= ')
    expect(calls[0].text).toContain('AND gh.redeemed_at < ')
    expect(calls[0].text).toContain('AND gh.user_twitch_username ILIKE ')
    expect(calls[0].text).toContain('AND c.rarity = ')
  })
})

describe('adminApiPg: getGachaChartPg', () => {
  it('LIMIT 10000・jsonb整形した行配列を返し、フィルタがバインドされる', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'g1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getGachaChartPg(
      {},
      { streamerId: 'streamer-1', fromDate: '2024-01-01T00:00:00Z' }
    )

    expect(data).toEqual([{ id: 'g1' }])
    expect(calls).toHaveLength(1)
    // 外側の jsonb_agg にも明示 ORDER BY を持たせている（サブクエリの
    // ORDER BY + LIMIT の並び順に暗黙で依存しない防御的な集約）
    expect(calls[0].text).toContain('jsonb_agg(row_json ORDER BY sort_redeemed_at DESC)')
    expect(calls[0].text).toContain('LIMIT 10000')
    expect(calls[0].text).toContain('AND gh.streamer_id = ')
    expect(calls[0].values).toEqual(['streamer-1', '2024-01-01T00:00:00Z'])
  })
})

describe('adminApiPg: getGachaTablePg', () => {
  it('件数クエリとデータクエリを共有WHEREで別々に発行し、{rows, count}を返す', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'g1' }], 42)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getGachaTablePg(
      {},
      { streamerId: 'streamer-1' },
      { offset: 20, pageSize: 10 }
    )

    expect(data).toEqual({ rows: [{ id: 'g1' }], count: 42 })
    expect(calls).toHaveLength(2)

    const countCall = calls.find((call) => call.text.includes('count(*)'))
    const dataCall = calls.find((call) => call.text.includes('jsonb_agg'))
    expect(countCall).toBeDefined()
    expect(dataCall).toBeDefined()

    // 件数クエリとデータクエリのWHERE条件（バインド値）が一致していること
    // （countGachaHistory/getGachaTablePg が同じ gachaHistoryFromWhere を共有するため）
    expect(countCall?.values).toEqual(['streamer-1'])
    expect(dataCall?.values).toEqual(['streamer-1', 10, 20])
    expect(dataCall?.text).toContain('LIMIT ')
    expect(dataCall?.text).toContain('OFFSET ')
    expect(dataCall?.text).toContain('ORDER BY gh.redeemed_at DESC, gh.id DESC')
  })

  it('該当0件でもcountを正しく取得できる（count(*)は常に1行返るため、要求ページが最終ページを超えても件数が消えない）', async () => {
    const { tag } = fakeSqlTag([], 0)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getGachaTablePg({}, {}, { offset: 1000, pageSize: 20 })

    expect(data).toEqual({ rows: [], count: 0 })
  })
})

describe('adminApiPg: getGachaExportRowsPg', () => {
  it('LIMIT 50000・単発クエリでCSV出力用の狭い列を返す', async () => {
    const { tag, calls } = fakeSqlTag([{ redeemed_at: '2024-01-01T00:00:00Z' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getGachaExportRowsPg({}, { rarity: 'legendary' })

    expect(data).toEqual([{ redeemed_at: '2024-01-01T00:00:00Z' }])
    // getGachaChartPg/getGachaTablePgと違いページングやcountクエリを伴わない単発クエリ
    expect(calls).toHaveLength(1)
    // LIMIT はバインドパラメータとして渡すため（GACHA_EXPORT_ROW_LIMIT_PG）、
    // テキストではなく values の末尾を確認する
    expect(calls[0].text).toContain('LIMIT ')
    expect(calls[0].values.at(-1)).toBe(50000)
    expect(calls[0].text).toContain('AND c.rarity = ')
    // chart/tableと違い user_twitch_id / card_id 等の広い列は SELECT リストに含めない
    // （JOIN条件としては gh.card_id を常に参照するため、出力列に絞ってチェックする）
    expect(calls[0].text).not.toContain('user_twitch_id')
    expect(calls[0].text).not.toContain("'card_id'")
  })
})

describe('adminApiPg: getDropRateStatsPg', () => {
  it('get_gacha_drop_stats(streamerId, fromDate, limitPerCard) を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag({ totalDraws: 10 })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getDropRateStatsPg(
      {},
      { streamerId: 'streamer-1', fromDate: '1970-01-01T00:00:00Z', limitPerCard: 20 }
    )

    expect(data).toEqual({ totalDraws: 10 })
    expect(calls[0].text).toContain('get_gacha_drop_stats(')
    expect(calls[0].values).toEqual(['streamer-1', '1970-01-01T00:00:00Z', 20])
  })
})

describe('adminApiPg: getUserCardsSummaryPg', () => {
  it('ユーザー行(狭い列)とget_user_card_counts()の結果を返す', async () => {
    const mod = await importAdminApiPg()
    const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const flattened = flattenFragment(strings, values)
      if (flattened.text.includes('FROM users')) {
        return Promise.resolve([
          { twitch_user_id: 'twitch-1', user_json: { id: 'user-1', twitch_user_id: 'twitch-1' } },
        ])
      }
      return Promise.resolve([{ result: [{ card: { id: 'c1' }, count: 3 }] }])
    })
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getUserCardsSummaryPg({}, 'user-1')

    expect(data).toEqual({
      user: { id: 'user-1', twitch_user_id: 'twitch-1' },
      cardCounts: [{ card: { id: 'c1' }, count: 3 }],
    })
    // 2つ目のクエリ(get_user_card_counts)は1つ目で取得したtwitch_user_idをバインドすること
    const rpcCall = tag.mock.calls.find((call) =>
      Array.from(call[0] as TemplateStringsArray).join('').includes('get_user_card_counts')
    )
    expect(rpcCall?.[1]).toBe('twitch-1')
  })

  // USER_SAFE_COLUMNS（localAdminApi.ts）と jsonb_build_object() の列集合
  // （adminApiPg.ts）は別ファイルで独立管理されているため、片方だけ更新される
  // ドリフトをここで検出する。twitch_access_token 等のOAuth秘匿列が誤って
  // 含まれていないことも合わせて確認する
  it('USER_SAFE_COLUMNSと同じ列集合をjsonb化し、OAuth秘匿列を含めない', async () => {
    const { tag, calls } = fakeSqlTag(null)
    const mod = await importAdminApiPg()
    const localAdminApi = await importLocalAdminApi()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await mod.getUserCardsSummaryPg({}, 'user-1').catch(() => {})

    const userCall = calls.find((call) => call.text.includes('FROM users'))
    expect(userCall).toBeDefined()
    for (const column of localAdminApi.USER_SAFE_COLUMNS.split(',').map((c) => c.trim())) {
      expect(userCall?.text).toContain(`'${column}'`)
    }
    expect(userCall?.text).not.toContain('twitch_access_token')
    expect(userCall?.text).not.toContain('twitch_refresh_token')
    expect(userCall?.text).not.toContain('to_jsonb(u.*)')
  })

  it('該当ユーザーが存在しない場合は404相当のエラーをthrowする（PostgREST版PGRST116と同じ契約）', async () => {
    const mod = await importAdminApiPg()
    const tag = vi.fn().mockResolvedValue([])
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await expect(mod.getUserCardsSummaryPg({}, 'missing-user')).rejects.toMatchObject({
      message: 'User not found',
      statusCode: 404,
    })
  })
})

describe('adminApiPg: getUserCardsTablePg', () => {
  it('user_cards→cards→streamersをJOINしたページ結果と件数を返す', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'uc1' }], 5)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getUserCardsTablePg(
      {},
      { userId: 'user-1', offset: 20, pageSize: 10 }
    )

    expect(data).toEqual({ rows: [{ id: 'uc1' }], count: 5 })
    const countCall = calls.find((call) => call.text.includes('count(*)'))
    const dataCall = calls.find((call) => call.text.includes('jsonb_agg'))
    expect(countCall?.values).toEqual(['user-1'])
    expect(dataCall?.text).toContain('JOIN cards c ON c.id = uc.card_id')
    expect(dataCall?.text).toContain('JOIN streamers s ON s.id = c.streamer_id')
    expect(dataCall?.values).toEqual(['user-1', 10, 20])
  })
})

describe('adminApiPg: getStreamerCardsPagePg', () => {
  it('cardsをrarity降順(アルファベット)→created_at降順でページングして返す', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'card1' }], 3)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getStreamerCardsPagePg(
      {},
      { streamerId: 'streamer-1', offset: 0, pageSize: 20 }
    )

    expect(data).toEqual({ rows: [{ id: 'card1' }], count: 3 })
    const dataCall = calls.find((call) => call.text.includes('jsonb_agg'))
    expect(dataCall?.text).toContain('ORDER BY c.rarity DESC, c.created_at DESC')
    expect(dataCall?.values).toEqual(['streamer-1', 20, 0])
  })
})

describe('adminApiPg: listSupportCodesPg', () => {
  it('support_codesを作成日降順で返す', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'code1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listSupportCodesPg({})

    expect(data).toEqual([{ id: 'code1' }])
    expect(calls[0].text).toContain('FROM support_codes sc')
    expect(calls[0].text).toContain('ORDER BY sc.created_at DESC')
  })
})

describe('adminApiPg: createSupportCodePg', () => {
  it('INSERT ... RETURNING でstatus=activeの新規行を返す', async () => {
    const { tag, calls } = fakeSqlTag({ id: 'new-code', status: 'active' })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.createSupportCodePg(
      {},
      { codeHash: 'hash-1', planType: 'support', memo: 'メモ' }
    )

    expect(data).toEqual({ id: 'new-code', status: 'active' })
    expect(calls[0].text).toContain('INSERT INTO support_codes')
    expect(calls[0].text).toContain("'active'")
    expect(calls[0].values).toEqual(['hash-1', 'support', 'メモ'])
  })
})

describe('adminApiPg: updateSupportCodeStatusPg', () => {
  it('UPDATE ... RETURNING で更新後の行を返す', async () => {
    const { tag, calls } = fakeSqlTag({ id: 'code-1', status: 'revoked' })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.updateSupportCodeStatusPg({}, { id: 'code-1', status: 'revoked' })

    expect(data).toEqual({ id: 'code-1', status: 'revoked' })
    expect(calls[0].text).toContain('UPDATE support_codes')
    expect(calls[0].values).toEqual(['revoked', 'code-1'])
  })

  // 注意: Supabase経路のPGRST116（対象0件）は`statusCode`を持たないため実際には
  // 素の500として露出する。pg経路のこの404は「同じ契約」の再現ではなく、
  // より正しいステータスコードへの意図的な改善（adminApiPg.tsのdocコメント参照）
  it('対象idが存在せず更新0件の場合は404相当のエラーをthrowする（Supabase経路の500より意味的に正しい応答への意図的な改善）', async () => {
    // 更新0件 = jsonb_agg等の集約なしで結果0行のクエリを再現するため、
    // resultをundefinedにしたfakeSqlTagで「0行」を模す
    const tag = vi.fn().mockResolvedValue([])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await expect(
      mod.updateSupportCodeStatusPg({}, { id: 'missing', status: 'revoked' })
    ).rejects.toMatchObject({ message: 'Support code not found', statusCode: 404 })
  })
})

describe('adminApiPg: revokeSupportCodePg', () => {
  it('revoke_support_code()を呼び、戻り値のJSONBを検査せず{ok: true}を返す', async () => {
    const { tag, calls } = fakeSqlTag({ error: 'CODE_NOT_FOUND' })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    // RPCの戻り値がCODE_NOT_FOUNDでも、SQLエラーでない限りPostgREST版と同じく
    // {ok: true}を返す（既存挙動、本移植で変更しない）
    const data = await mod.revokeSupportCodePg({}, 'code-1')

    expect(data).toEqual({ ok: true })
    expect(calls[0].text).toContain('revoke_support_code(')
    expect(calls[0].values).toEqual(['code-1'])
  })

  it('SQLエラーはそのまま伝播する', async () => {
    const tag = vi.fn().mockRejectedValue(new Error('invalid input syntax for type uuid'))
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await expect(mod.revokeSupportCodePg({}, 'not-a-uuid')).rejects.toThrow(
      'invalid input syntax for type uuid'
    )
  })
})

describe('adminApiPg: listLicensesPg', () => {
  it('user_licensesとusersをLEFT JOINし、未登録ユーザーはtwitch_user_idをそのまま表示名にする', async () => {
    const { tag, calls } = fakeSqlTag([
      { twitch_user_id: 'twitch-1', twitch_username: 'Alice' },
      { twitch_user_id: 'twitch-unknown', twitch_username: 'twitch-unknown' },
    ])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listLicensesPg({})

    expect(data).toEqual([
      { twitch_user_id: 'twitch-1', twitch_username: 'Alice' },
      { twitch_user_id: 'twitch-unknown', twitch_username: 'twitch-unknown' },
    ])
    expect(calls[0].text).toContain('LEFT JOIN users u ON u.twitch_user_id = ul.twitch_user_id')
    expect(calls[0].text).toContain('COALESCE(u.twitch_display_name, ul.twitch_user_id)')
    expect(calls[0].text).toContain('ORDER BY sort_activated_at DESC')
  })
})

describe('adminApiPg: listTwitchSubsPg', () => {
  it('twitch_has_sub=trueのユーザーを{rows, count}で返す', async () => {
    const { tag, calls } = fakeSqlTag([{ twitch_user_id: 'twitch-1' }], 5)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listTwitchSubsPg({})

    expect(data).toEqual({ rows: [{ twitch_user_id: 'twitch-1' }], count: 5 })
    const countCall = calls.find((call) => call.text.includes('count(*)'))
    const dataCall = calls.find((call) => call.text.includes('jsonb_agg'))
    expect(countCall?.text).toContain('WHERE u.twitch_has_sub = true')
    expect(dataCall?.text).toContain('WHERE u.twitch_has_sub = true')
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

describe('localAdminApi: escapeIlikePattern/computeExclusiveToDateIso/resolveGachaDateFilters', () => {
  it('escapeIlikePattern: % と _ をエスケープする', async () => {
    const { escapeIlikePattern } = await importLocalAdminApi()
    expect(escapeIlikePattern('100%_off')).toBe('100\\%\\_off')
  })

  it('computeExclusiveToDateIso: 指定日の翌日0時(UTC)のISO文字列を返す', async () => {
    const { computeExclusiveToDateIso } = await importLocalAdminApi()
    expect(computeExclusiveToDateIso('2024-01-31')).toBe('2024-02-01T00:00:00.000Z')
  })

  it('resolveGachaDateFilters: from/toとも未指定ならrangeのfromDateのみ使う', async () => {
    const { resolveGachaDateFilters } = await importLocalAdminApi()
    expect(resolveGachaDateFilters({ range: 'all', from: '', to: '' })).toEqual({
      fromDate: undefined,
      toDateExclusive: undefined,
    })
  })

  it('resolveGachaDateFilters: fromが指定されるとrangeは無視される', async () => {
    const { resolveGachaDateFilters } = await importLocalAdminApi()
    const result = resolveGachaDateFilters({ range: '7d', from: '2024-01-01', to: '' })
    expect(result.fromDate).toBe('2024-01-01T00:00:00Z')
  })

  it('resolveGachaDateFilters: toのみ指定でも独立に適用される（fromはrangeで絞り込まれない）', async () => {
    const { resolveGachaDateFilters } = await importLocalAdminApi()
    const result = resolveGachaDateFilters({ range: '7d', from: '', to: '2024-01-31' })
    expect(result.fromDate).toBeUndefined()
    expect(result.toDateExclusive).toBe('2024-02-01T00:00:00.000Z')
  })

  it('resolveGachaDateFilters: from/to両方指定なら両方とも独立に適用される（rangeは無視）', async () => {
    const { resolveGachaDateFilters } = await importLocalAdminApi()
    const result = resolveGachaDateFilters({ range: '7d', from: '2024-01-01', to: '2024-01-31' })
    expect(result.fromDate).toBe('2024-01-01T00:00:00Z')
    expect(result.toDateExclusive).toBe('2024-02-01T00:00:00.000Z')
  })
})

describe('localAdminApi: getGachaChart の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の from()...チェーンのみを呼び、pg 経路には触れない', async () => {
    const rows = [{ id: 'g1', redeemed_at: '2024-01-01T00:00:00Z' }]
    const client = fakeQueryBuilderClient({ data: rows })
    const { getGachaChart } = await importLocalAdminApi()

    const data = await getGachaChart(client, { range: 'all', streamerId: 'streamer-1' }, {})

    expect(data).toEqual(rows)
    expect(client.from).toHaveBeenCalledWith('gacha_history')
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'g1' }])
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [{ id: 'legacy' }] })
    const { getGachaChart } = await importLocalAdminApi()

    const data = await getGachaChart(
      client,
      { range: 'all', streamerId: 'streamer-1' },
      { ANALYSIS_DB_DRIVER: 'pg' }
    )

    expect(data).toEqual([{ id: 'g1' }])
    expect(client.from).not.toHaveBeenCalled()
    expect(calls[0].values).toEqual(['streamer-1'])
  })
})

describe('localAdminApi: getGachaTable の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  const tableParams = {
    range: 'all' as const,
    page: 3,
    pageSize: 10,
    username: '',
    rarity: '',
    from: '',
    to: '',
    streamerId: undefined,
  }

  it('未設定なら Supabase の from()...チェーンのみを呼び、pg 経路には触れない', async () => {
    const rows = [{ id: 'g1' }]
    const client = fakeQueryBuilderClient({ data: rows, count: 42 })
    const { getGachaTable } = await importLocalAdminApi()

    const data = await getGachaTable(client, tableParams, {})

    expect(data).toEqual({ rows, count: 42 })
    expect(client.from).toHaveBeenCalledWith('gacha_history')
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路（page/pageSizeからのoffset計算含む）を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'g1' }], 7)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [{ id: 'legacy' }], count: 1 })
    const { getGachaTable } = await importLocalAdminApi()

    const data = await getGachaTable(client, tableParams, { ANALYSIS_DB_DRIVER: 'pg' })

    expect(data).toEqual({ rows: [{ id: 'g1' }], count: 7 })
    expect(client.from).not.toHaveBeenCalled()
    // page=3, pageSize=10 → offset=(3-1)*10=20
    const dataCall = calls.find((call) => call.text.includes('jsonb_agg'))
    expect(dataCall?.values).toEqual([10, 20])
  })

  // gachaHistoryFromWhere自体は単体テスト済みだが、それだけでは
  // 「getGachaTableがusername/rarity/from/toを正しくGachaHistoryFiltersへ
  // 詰め替えているか（%ラップ・エスケープ・from/to優先ロジック含む）」という
  // “配線”部分の退行を検出できない。ここでは全フィルタを指定した状態で
  // pg経路を通し、gachaHistoryFromWhereへ渡る直前の値を検証する
  it('ANALYSIS_DB_DRIVER=pg: username/rarity/from/to/streamerId が正しく詰め替えられる', async () => {
    const { tag, calls } = fakeSqlTag([], 0)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [], count: 0 })
    const { getGachaTable } = await importLocalAdminApi()

    await getGachaTable(
      client,
      {
        range: '7d',
        page: 1,
        pageSize: 20,
        username: '100%_off',
        rarity: 'legendary',
        from: '2024-01-01',
        to: '2024-01-31',
        streamerId: 'streamer-9',
      },
      { ANALYSIS_DB_DRIVER: 'pg' }
    )

    const countCall = calls.find((call) => call.text.includes('count(*)'))
    // gachaHistoryFromWhereへの引数順（streamerId, fromDate, toDateExclusive,
    // usernameIlike, rarity）どおりにバインドされていること。
    // usernameIlikeは `%` ラップ済み・`%`/`_` エスケープ済みであること
    // （エスケープが抜けると '100%_off' のまま渡り ILIKE のワイルドカード動作が変わる）。
    // from/toを両方指定しているので range('7d')は無視され、from/toがそのまま使われる
    expect(countCall?.values).toEqual([
      'streamer-9',
      '2024-01-01T00:00:00Z',
      '2024-02-01T00:00:00.000Z',
      '%100\\%\\_off%',
      'legendary',
    ])
  })
})

describe('localAdminApi: getGachaExportRows の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  const exportParams = {
    range: 'all' as const,
    username: '',
    rarity: '',
    from: '',
    to: '',
    streamerId: undefined,
  }

  it('未設定なら Supabase の from()...チェーンのみを呼び、pg 経路には触れない', async () => {
    const rows = [
      {
        redeemed_at: '2024-01-01T00:00:00Z',
        user_twitch_username: 'alice',
        cards: null,
        streamers: null,
      },
    ]
    const client = fakeQueryBuilderClient({ data: rows })
    const { getGachaExportRows } = await importLocalAdminApi()

    const data = await getGachaExportRows(client, exportParams, {})

    expect(data).toEqual(rows)
    expect(client.from).toHaveBeenCalledWith('gacha_history')
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路（LIMIT 50000の単発クエリ）を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ redeemed_at: '2024-01-01T00:00:00Z' }])
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [] })
    const { getGachaExportRows } = await importLocalAdminApi()

    const data = await getGachaExportRows(client, exportParams, { ANALYSIS_DB_DRIVER: 'pg' })

    expect(data).toEqual([{ redeemed_at: '2024-01-01T00:00:00Z' }])
    expect(client.from).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })
})

describe('localAdminApi: getDropRateStats の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase RPC 経路のみを呼び、pg 経路には触れない', async () => {
    const client = fakeRpcClient({ totalDraws: 1 })
    const { getDropRateStats } = await importLocalAdminApi()

    const data = await getDropRateStats(client, { streamerId: 'streamer-1', range: 'all' }, {})

    expect(data).toEqual({ totalDraws: 1 })
    expect(client.rpc).toHaveBeenCalledWith('get_gacha_drop_stats', {
      p_streamer_id: 'streamer-1',
      p_from_date: '1970-01-01T00:00:00Z',
      p_limit_per_card: 20,
    })
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag({ totalDraws: 9 })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeRpcClient({ totalDraws: 1 })
    const { getDropRateStats } = await importLocalAdminApi()

    const data = await getDropRateStats(
      client,
      { streamerId: 'streamer-1', range: 'all' },
      { ANALYSIS_DB_DRIVER: 'pg' }
    )

    expect(data).toEqual({ totalDraws: 9 })
    expect(client.rpc).not.toHaveBeenCalled()
  })
})

// getUserCardsSummary の default 経路は .from('users')...(builder) と
// .rpc('get_user_card_counts', ...) の両方を使うため、builder+rpc両対応のfakeが必要
function fakeUserCardsSummaryClient(user: unknown, cardCounts: unknown): any {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    single: vi.fn(() => builder),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({ data: user, error: null }).then(onFulfilled, onRejected),
  }
  return {
    from: vi.fn(() => builder),
    rpc: vi.fn().mockResolvedValue({ data: cardCounts, error: null }),
    builder,
  }
}

describe('localAdminApi: getUserCardsSummary の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の from()+rpc() のみを呼び、pg 経路には触れない', async () => {
    const client = fakeUserCardsSummaryClient(
      { id: 'user-1', twitch_user_id: 'twitch-1' },
      [{ card: { id: 'c1' }, count: 2 }]
    )
    const { getUserCardsSummary } = await importLocalAdminApi()

    const data = await getUserCardsSummary(client, 'user-1', {})

    expect(data).toEqual({
      user: { id: 'user-1', twitch_user_id: 'twitch-1' },
      cardCounts: [{ card: { id: 'c1' }, count: 2 }],
    })
    expect(client.from).toHaveBeenCalledWith('users')
    // select('*') に退行するとOAuth秘匿列（twitch_access_token等）が漏れるため、
    // USER_SAFE_COLUMNSがそのまま渡っていることを明示的に検証する
    const localAdminApi = await importLocalAdminApi()
    expect(client.builder.select).toHaveBeenCalledWith(localAdminApi.USER_SAFE_COLUMNS)
    expect(client.rpc).toHaveBeenCalledWith('get_user_card_counts', { p_twitch_user_id: 'twitch-1' })
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const mod = await importAdminApiPg()
    const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const flattened = flattenFragment(strings, values)
      if (flattened.text.includes('FROM users')) {
        return Promise.resolve([{ twitch_user_id: 'twitch-9', user_json: { id: 'pg-user' } }])
      }
      return Promise.resolve([{ result: [{ card: { id: 'c9' }, count: 4 }] }])
    })
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeUserCardsSummaryClient({ id: 'legacy' }, [])
    const { getUserCardsSummary } = await importLocalAdminApi()

    const data = await getUserCardsSummary(client, 'user-1', { ANALYSIS_DB_DRIVER: 'pg' })

    expect(data).toEqual({ user: { id: 'pg-user' }, cardCounts: [{ card: { id: 'c9' }, count: 4 }] })
    expect(client.from).not.toHaveBeenCalled()
    expect(client.rpc).not.toHaveBeenCalled()
  })
})

describe('localAdminApi: getUserCardsTable の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の from()...チェーンのみを呼び、pg 経路には触れない', async () => {
    const client = fakeQueryBuilderClient({ data: [], count: 0 })
    const { getUserCardsTable } = await importLocalAdminApi()

    const data = await getUserCardsTable(client, { userId: 'user-1', page: 1, pageSize: 20 }, {})

    expect(data).toEqual({ rows: [], count: 0 })
    expect(client.from).toHaveBeenCalledWith('user_cards')
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路（page/pageSizeからのoffset計算含む）を呼ぶ', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'uc1' }], 1)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [], count: 0 })
    const { getUserCardsTable } = await importLocalAdminApi()

    const data = await getUserCardsTable(
      client,
      { userId: 'user-1', page: 2, pageSize: 15 },
      { ANALYSIS_DB_DRIVER: 'pg' }
    )

    expect(data).toEqual({ rows: [{ id: 'uc1' }], count: 1 })
    expect(client.from).not.toHaveBeenCalled()
    // page=2, pageSize=15 → offset=(2-1)*15=15
    const dataCall = calls.find((call) => call.text.includes('jsonb_agg'))
    expect(dataCall?.values).toEqual(['user-1', 15, 15])
  })
})

describe('localAdminApi: getStreamerCardsPage の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の from()...チェーンのみを呼び、pg 経路には触れない', async () => {
    const client = fakeQueryBuilderClient({ data: [], count: 0 })
    const { getStreamerCardsPage } = await importLocalAdminApi()

    const data = await getStreamerCardsPage(
      client,
      { streamerId: 'streamer-1', page: 1, pageSize: 20 },
      {}
    )

    expect(data).toEqual({ rows: [], count: 0 })
    expect(client.from).toHaveBeenCalledWith('cards')
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag([{ id: 'card1' }], 1)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [], count: 0 })
    const { getStreamerCardsPage } = await importLocalAdminApi()

    const data = await getStreamerCardsPage(
      client,
      { streamerId: 'streamer-1', page: 1, pageSize: 20 },
      { ANALYSIS_DB_DRIVER: 'pg' }
    )

    expect(data).toEqual({ rows: [{ id: 'card1' }], count: 1 })
    expect(client.from).not.toHaveBeenCalled()
  })
})

describe('localAdminApi: listSupportCodes の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の from()...チェーンのみを呼び、pg 経路には触れない', async () => {
    const client = fakeQueryBuilderClient({ data: [{ id: 'code1' }] })
    const { listSupportCodes } = await importLocalAdminApi()

    const data = await listSupportCodes(client, {})

    expect(data).toEqual([{ id: 'code1' }])
    expect(client.from).toHaveBeenCalledWith('support_codes')
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag([{ id: 'code-pg' }])
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [] })
    const { listSupportCodes } = await importLocalAdminApi()

    const data = await listSupportCodes(client, { ANALYSIS_DB_DRIVER: 'pg' })

    expect(data).toEqual([{ id: 'code-pg' }])
    expect(client.from).not.toHaveBeenCalled()
  })
})

// createSupportCode/updateSupportCodeStatus の default 経路は
// .from().insert()/.update()...select().single() を使うため、insert/update
// も含めたbuilderが必要（fakeQueryBuilderClientはselect系のみのため専用に用意する）
function fakeWriteBuilderClient(resolved: { data: unknown; error?: unknown }): any {
  const builder: any = {
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    single: vi.fn(() => builder),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({ data: resolved.data, error: resolved.error ?? null }).then(
        onFulfilled,
        onRejected
      ),
  }
  return { from: vi.fn(() => builder), rpc: vi.fn(), builder }
}

describe('localAdminApi: createSupportCode の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の insert().select().single() のみを呼び、pg 経路には触れない', async () => {
    const client = fakeWriteBuilderClient({ data: { id: 'code1', status: 'active' } })
    const { createSupportCode } = await importLocalAdminApi()

    const data = await createSupportCode(
      client,
      { code_hash: 'hash-1', plan_type: 'support', memo: 'メモ' },
      {}
    )

    expect(data).toEqual({ id: 'code1', status: 'active' })
    expect(client.builder.insert).toHaveBeenCalledWith({
      code_hash: 'hash-1',
      plan_type: 'support',
      status: 'active',
      memo: 'メモ',
    })
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag({ id: 'code-pg', status: 'active' })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeWriteBuilderClient({ data: null })
    const { createSupportCode } = await importLocalAdminApi()

    const data = await createSupportCode(
      client,
      { code_hash: 'hash-1', plan_type: 'support', memo: 'メモ' },
      { ANALYSIS_DB_DRIVER: 'pg' }
    )

    expect(data).toEqual({ id: 'code-pg', status: 'active' })
    expect(client.from).not.toHaveBeenCalled()
  })
})

describe('localAdminApi: updateSupportCodeStatus の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の update().eq().select().single() のみを呼び、pg 経路には触れない', async () => {
    const client = fakeWriteBuilderClient({ data: { id: 'code1', status: 'revoked' } })
    const { updateSupportCodeStatus } = await importLocalAdminApi()

    const data = await updateSupportCodeStatus(client, 'code1', 'revoked', {})

    expect(data).toEqual({ id: 'code1', status: 'revoked' })
    expect(client.builder.eq).toHaveBeenCalledWith('id', 'code1')
    // update()に渡るオブジェクト自体（status値の脱落等）も検証する
    expect(client.builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'revoked' })
    )
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag({ id: 'code-pg', status: 'revoked' })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeWriteBuilderClient({ data: null })
    const { updateSupportCodeStatus } = await importLocalAdminApi()

    const data = await updateSupportCodeStatus(client, 'code1', 'revoked', {
      ANALYSIS_DB_DRIVER: 'pg',
    })

    expect(data).toEqual({ id: 'code-pg', status: 'revoked' })
    expect(client.from).not.toHaveBeenCalled()
  })
})

describe('localAdminApi: revokeSupportCode の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase RPC 経路のみを呼び、pg 経路には触れない', async () => {
    const client = fakeRpcClient(null)
    const { revokeSupportCode } = await importLocalAdminApi()

    const data = await revokeSupportCode(client, 'code-1', {})

    expect(data).toEqual({ ok: true })
    expect(client.rpc).toHaveBeenCalledWith('revoke_support_code', { p_code_id: 'code-1' })
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag(null)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeRpcClient(null)
    const { revokeSupportCode } = await importLocalAdminApi()

    const data = await revokeSupportCode(client, 'code-1', { ANALYSIS_DB_DRIVER: 'pg' })

    expect(data).toEqual({ ok: true })
    expect(client.rpc).not.toHaveBeenCalled()
  })
})

describe('localAdminApi: listLicenses の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の from()...チェーンのみを呼び、pg 経路には触れない', async () => {
    const client = fakeQueryBuilderClient({ data: [] })
    const { listLicenses } = await importLocalAdminApi()

    const data = await listLicenses(client, {})

    expect(data).toEqual([])
    expect(client.from).toHaveBeenCalledWith('user_licenses')
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag([{ twitch_user_id: 'twitch-1' }])
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [] })
    const { listLicenses } = await importLocalAdminApi()

    const data = await listLicenses(client, { ANALYSIS_DB_DRIVER: 'pg' })

    expect(data).toEqual([{ twitch_user_id: 'twitch-1' }])
    expect(client.from).not.toHaveBeenCalled()
  })
})

describe('localAdminApi: listTwitchSubs の ANALYSIS_DB_DRIVER による経路切替（回帰確認）', () => {
  it('未設定なら Supabase の from()...チェーンのみを呼び、pg 経路には触れない', async () => {
    const client = fakeQueryBuilderClient({ data: [], count: 0 })
    const { listTwitchSubs } = await importLocalAdminApi()

    const data = await listTwitchSubs(client, {})

    expect(data).toEqual({ rows: [], count: 0 })
    expect(client.from).toHaveBeenCalledWith('users')
  })

  it('ANALYSIS_DB_DRIVER=pg なら pg 経路を呼び、Supabase client には触れない', async () => {
    const { tag } = fakeSqlTag([{ twitch_user_id: 'twitch-1' }], 1)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const client = fakeQueryBuilderClient({ data: [], count: 0 })
    const { listTwitchSubs } = await importLocalAdminApi()

    const data = await listTwitchSubs(client, { ANALYSIS_DB_DRIVER: 'pg' })

    expect(data).toEqual({ rows: [{ twitch_user_id: 'twitch-1' }], count: 1 })
    expect(client.from).not.toHaveBeenCalled()
  })
})
