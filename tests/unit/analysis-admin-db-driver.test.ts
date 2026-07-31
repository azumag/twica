/**
 * #708 analysis ダッシュボード admin backend のPostgres専用経路
 * （overview / leaderboard / users / streamers / gacha / support）のテスト。
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
  vi.useRealTimers()
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

  it('listUsersPg: ページとフィルタをget_analysis_users_page()へバインドする', async () => {
    const expected = { rows: [{ id: 'u1' }], count: 1, summary: {} }
    const { tag, calls } = fakeSqlTag(expected)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listUsersPg({}, {
      page: 2,
      pageSize: 10,
      search: '%alice%',
      sort: 'name_asc',
      hideZeroCards: true,
    })

    expect(data).toEqual(expected)
    expect(calls[0].text).toContain('get_analysis_users_page(')
    expect(calls[0].values).toEqual([2, 10, '%alice%', 'name_asc', true])
  })

  it('listStreamersWithStatsPg: ページとフィルタをget_analysis_streamers_page()へバインドする', async () => {
    const expected = { rows: [{ id: 'st1' }], count: 1, summary: {} }
    const { tag, calls } = fakeSqlTag(expected)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listStreamersWithStatsPg({}, {
      page: 1,
      pageSize: 20,
      search: '%channel%',
      sort: 'storage_desc',
      hideZeroCards: true,
      filterChatEnabled: true,
      filterHasTemplate: false,
      filterMissingScope: true,
      filterVoteCampaign: false,
    })

    expect(data).toEqual(expected)
    expect(calls[0].text).toContain('get_analysis_streamers_page(')
    expect(calls[0].values).toEqual([
      1,
      20,
      '%channel%',
      'storage_desc',
      true,
      true,
      false,
      true,
      false,
    ])
  })

  it('getStreamerOptionsPg: 軽量候補をページングして取得する', async () => {
    const expected = { rows: [{ id: 'st1' }], count: 1 }
    const { tag, calls } = fakeSqlTag(expected)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getStreamerOptionsPg({}, { page: 1, pageSize: 50, search: '%chan%' })

    expect(data).toEqual(expected)
    expect(calls[0].text).toContain('get_analysis_streamer_options_page(')
    expect(calls[0].values).toEqual([1, 50, '%chan%'])
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

describe('adminApiPg: getStreamerByIdPg', () => {
  it('idで1件を取得しto_jsonbで返す', async () => {
    const { tag, calls } = fakeSqlTag({ id: 'streamer-1', name: 'テスト配信者' })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getStreamerByIdPg({}, 'streamer-1')

    expect(data).toEqual({ id: 'streamer-1', name: 'テスト配信者' })
    expect(calls[0].text).toContain('FROM streamers s WHERE s.id = ')
    expect(calls[0].values).toEqual(['streamer-1'])
  })

  it('対象0件なら明示的に404を投げる', async () => {
    const { tag } = fakeSqlTag(undefined)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await expect(mod.getStreamerByIdPg({}, 'missing')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('adminApiPg: stripPostgresJsIncompatibleSslParams（PlanetScale sslrootcert非互換修正）', () => {
  // 実PlanetScale previewで実機確認済み: PlanetScaleダッシュボードが提供する接続文字列は
  // `?sslmode=verify-full&sslrootcert=system` を付与するが、postgres.js は sslrootcert を
  // 認識せず未知の接続オプションとしてサーバーへ送りつけてしまい
  // `unrecognized configuration parameter "sslrootcert"` で接続失敗する
  // （src/lib/db/client.ts / scripts/lib/db-migrate-core.js の同名関数と同じロジック。
  // analysis/ は別npmパッケージのため独立実装している）。
  it('sslrootcert のみを取り除き、既存の sslmode はそのまま残す', async () => {
    const mod = await importAdminApiPg()
    const input =
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full&sslrootcert=system'
    const result = mod.stripPostgresJsIncompatibleSslParams(input)
    expect(result).toBe(
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full'
    )
  })

  it('sslrootcert が無い接続文字列は完全に同一のまま返す', async () => {
    const mod = await importAdminApiPg()
    const input = 'postgres://user:pass@db.example.com:5432/mydb?sslmode=require'
    expect(mod.stripPostgresJsIncompatibleSslParams(input)).toBe(input)
  })

  // Major-1（Fableレビュー・セキュリティ上重大）: sslrootcert=system のみでsslmode未指定の
  // URLは、sslrootcertを単純に削除しただけだとpostgres.jsがssl=false（平文接続）として
  // 扱ってしまう。sslmode=verify-full を明示的に補うことで完全な証明書検証を維持する。
  // analysis/ の独立コピーにも root と同じ修正が必要（Major-3のコメント参照）。
  it('Major-1: sslrootcert=system のみ（sslmode無し）の場合、sslmode=verify-full を明示的に補う', async () => {
    const mod = await importAdminApiPg()
    const input = 'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslrootcert=system'
    const result = mod.stripPostgresJsIncompatibleSslParams(input)
    expect(result).toBe(
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full'
    )
  })

  it('Major-1: sslrootcert=system と sslmode の両方が指定されている場合、既存の sslmode を尊重し上書きしない', async () => {
    const mod = await importAdminApiPg()
    const input =
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=require&sslrootcert=system'
    const result = mod.stripPostgresJsIncompatibleSslParams(input)
    expect(result).toBe(
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=require'
    )
  })

  it('パース不能な接続文字列は変換をあきらめて元の文字列をそのまま返す', async () => {
    const mod = await importAdminApiPg()
    const input = 'not a valid url at all :::'
    expect(mod.stripPostgresJsIncompatibleSslParams(input)).toBe(input)
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
    // getGachaTablePgと違いページングやcountクエリを伴わない単発クエリ
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

  it('該当ユーザーが存在しない場合は404相当のエラーをthrowする', async () => {
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

  it('対象idが存在せず更新0件の場合は404相当のエラーをthrowする', async () => {
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

    // 関数の戻り値がCODE_NOT_FOUNDでも、SQLエラーでない限り既存API契約の
    // {ok: true}を返す。
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

describe('adminApiPg: getSupportInquiriesPg', () => {
  it("status='all'なら絞り込まない", async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'inq1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.getSupportInquiriesPg({}, 'all')

    expect(data).toEqual([{ id: 'inq1' }])
    expect(calls[0].text).not.toContain('AND si.status')
    expect(calls[0].values).toEqual([])
  })

  it('status指定時はWHERE条件が追加される', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'inq1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await mod.getSupportInquiriesPg({}, 'open')

    expect(calls[0].text).toContain('AND si.status = ')
    expect(calls[0].values).toEqual(['open'])
  })

  it("status=''でもtruthyガードでスキップせずWHERE条件を適用する（fail-open防止）", async () => {
    const { tag, calls } = fakeSqlTag([])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await mod.getSupportInquiriesPg({}, '')

    expect(calls[0].text).toContain('AND si.status = ')
    expect(calls[0].values).toEqual([''])
  })
})

describe('adminApiPg: updateSupportInquiryStatusPg', () => {
  it('UPDATE ... RETURNING で更新後の行を返す', async () => {
    const { tag, calls } = fakeSqlTag({ id: 'inq1', status: 'resolved' })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.updateSupportInquiryStatusPg({}, { id: 'inq1', status: 'resolved' })

    expect(data).toEqual({ id: 'inq1', status: 'resolved' })
    expect(calls[0].text).toContain('UPDATE support_inquiries')
    expect(calls[0].values).toEqual(['resolved', 'inq1'])
  })

  it('対象idが存在せず更新0件の場合は404相当のエラーをthrowする', async () => {
    const tag = vi.fn().mockResolvedValue([])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await expect(
      mod.updateSupportInquiryStatusPg({}, { id: 'missing', status: 'resolved' })
    ).rejects.toMatchObject({ message: 'Support inquiry not found', statusCode: 404 })
  })
})

describe('adminApiPg: listSupportInquiryMessagesPg', () => {
  it('inquiry_idで絞り込み、created_at昇順で返す', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'msg1' }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listSupportInquiryMessagesPg({}, 'inq1')

    expect(data).toEqual([{ id: 'msg1' }])
    expect(calls[0].text).toContain('WHERE sim.inquiry_id = ')
    expect(calls[0].text).toContain('ORDER BY sim.created_at ASC')
    expect(calls[0].values).toEqual(['inq1'])
  })
})

describe('adminApiPg: createSupportInquiryMessagePg', () => {
  it("sender_type/sender_idを'admin'固定でINSERTする", async () => {
    const { tag, calls } = fakeSqlTag({ id: 'msg1', sender_type: 'admin' })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.createSupportInquiryMessagePg({}, { inquiryId: 'inq1', body: '返信本文' })

    expect(data).toEqual({ id: 'msg1', sender_type: 'admin' })
    expect(calls[0].text).toContain('INSERT INTO support_inquiry_messages')
    expect(calls[0].text).toContain("'admin', 'admin'")
    expect(calls[0].values).toEqual(['inq1', '返信本文'])
  })
})

describe('adminApiPg: listAnnouncementsPg', () => {
  it('read_countを相関サブクエリで計算しcreated_at降順で返す', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'ann1', read_count: 3 }])
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.listAnnouncementsPg({})

    expect(data).toEqual([{ id: 'ann1', read_count: 3 }])
    expect(calls[0].text).toContain(
      'FROM announcement_reads ar WHERE ar.announcement_id = a.id'
    )
    expect(calls[0].text).toContain('ORDER BY sort_created_at DESC')
    expect(calls[0].values).toEqual([])
  })
})

describe('adminApiPg: createAnnouncementPg', () => {
  it('read_countを0固定でマージしてINSERTする', async () => {
    const { tag, calls } = fakeSqlTag({ id: 'ann1', title: 'タイトル' })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const payload = {
      title: 'タイトル',
      body: '本文',
      severity: 'info',
      is_published: true,
      published_at: null,
      expires_at: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    const data = await mod.createAnnouncementPg({}, payload)

    expect(data).toEqual({ id: 'ann1', title: 'タイトル' })
    expect(calls[0].text).toContain('INSERT INTO announcements')
    expect(calls[0].text).toContain("jsonb_build_object('read_count', 0)")
    expect(calls[0].values).toEqual([
      'タイトル',
      '本文',
      'info',
      true,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
    ])
  })
})

describe('adminApiPg: updateAnnouncementPg', () => {
  it("title/body/severityを含む更新はSET句にフィールド全体を含める", async () => {
    const { tag, calls } = fakeSqlTag({ id: 'ann1', title: '更新後' })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const update = {
      title: '更新後',
      body: '本文',
      severity: 'warning',
      is_published: true,
      published_at: null,
      expires_at: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    }
    const data = await mod.updateAnnouncementPg({}, 'ann1', update)

    expect(data).toEqual({ id: 'ann1', title: '更新後' })
    expect(calls[0].text).toContain('UPDATE announcements')
    expect(calls[0].text).toContain('title = ')
    expect(calls[0].text).toContain('severity = ')
    expect(calls[0].values).toEqual([
      '更新後',
      '本文',
      'warning',
      true,
      null,
      null,
      '2026-01-01T00:00:00.000Z',
      'ann1',
    ])
  })

  it('公開状態トグルのみの更新はSET句をis_published/updated_atの2列に絞る', async () => {
    const { tag, calls } = fakeSqlTag({ id: 'ann1', is_published: false })
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const update = { is_published: false, updated_at: '2026-01-01T00:00:00.000Z' }
    const data = await mod.updateAnnouncementPg({}, 'ann1', update)

    expect(data).toEqual({ id: 'ann1', is_published: false })
    expect(calls[0].text).not.toContain('title = ')
    expect(calls[0].text).toContain('is_published = ')
    expect(calls[0].values).toEqual([false, '2026-01-01T00:00:00.000Z', 'ann1'])
  })

  it('対象0件なら明示的に404を投げる', async () => {
    const { tag } = fakeSqlTag(undefined)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    await expect(
      mod.updateAnnouncementPg({}, 'missing', {
        is_published: true,
        updated_at: '2026-01-01T00:00:00.000Z',
      })
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('adminApiPg: deleteAnnouncementPg', () => {
  it('対象0件でもエラーにせず常にokを返す（既存API契約を維持）', async () => {
    const { tag, calls } = fakeSqlTag(undefined)
    const mod = await importAdminApiPg()
    mod.__setAnalysisSqlFactoryForTests(() => tag as never)

    const data = await mod.deleteAnnouncementPg({}, 'ann1')

    expect(data).toEqual({ ok: true })
    expect(calls[0].text).toContain('DELETE FROM announcements')
    expect(calls[0].values).toEqual(['ann1'])
  })
})

describe('localAdminApi: Postgres専用wrapper', () => {
  const simpleWrappers = [
    {
      name: 'getOverview',
      sql: 'get_analysis_overview()',
      call: (mod: any) => mod.getOverview({}),
    },
    {
      name: 'getStreamerLeaderboard',
      sql: 'get_analysis_streamer_leaderboard()',
      call: (mod: any) => mod.getStreamerLeaderboard({}),
    },
    {
      name: 'listUsers',
      sql: 'get_analysis_users_page(',
      call: (mod: any) => mod.listUsers({ page: 1, pageSize: 20 }, {}),
    },
    {
      name: 'listStreamersWithStats',
      sql: 'get_analysis_streamers_page(',
      call: (mod: any) => mod.listStreamersWithStats({ page: 1, pageSize: 20 }, {}),
    },
  ]

  it.each(simpleWrappers)(
    '$name は旧client引数なしでPostgres関数を呼ぶ',
    async ({ sql, call }) => {
      const expected = { source: 'postgres' }
      const { tag, calls } = fakeSqlTag(expected)
      const adminApiPg = await importAdminApiPg()
      adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
      const localAdminApi = await importLocalAdminApi()

      await expect(call(localAdminApi)).resolves.toEqual(expected)
      expect(calls).toHaveLength(1)
      expect(calls[0].text).toContain(sql)
    }
  )

  it('getStreamerById はidをPostgres wrapperへ渡す', async () => {
    const { tag, calls } = fakeSqlTag({ id: 'streamer-1' })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const { getStreamerById } = await importLocalAdminApi()

    await expect(getStreamerById('streamer-1', {})).resolves.toEqual({
      id: 'streamer-1',
    })
    expect(calls[0].values).toEqual(['streamer-1'])
  })

  it('getGachaSummary はrangeとstreamerIdをPostgres引数へ正規化する', async () => {
    const { tag, calls } = fakeSqlTag({ totalGacha: 9 })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const { getGachaSummary } = await importLocalAdminApi()

    const data = await getGachaSummary(
      { range: 'all', streamerId: 'streamer-1' },
      {}
    )

    expect(data).toEqual({ totalGacha: 9 })
    expect(calls[0].values).toEqual([null, 'streamer-1'])
  })

  it('getGachaTable はfilter・escape・offsetをPostgres引数へ詰め替える', async () => {
    const { tag, calls } = fakeSqlTag([{ id: 'g1' }], 1)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const { getGachaTable } = await importLocalAdminApi()

    const data = await getGachaTable(
      {
        range: 'all',
        page: 3,
        pageSize: 10,
        username: '100%_viewer',
        rarity: 'rare',
        from: '2024-01-01',
        to: '2024-01-31',
        streamerId: 'streamer-1',
      },
      {}
    )

    expect(data).toEqual({ rows: [{ id: 'g1' }], count: 1 })
    const dataCall = calls.find((call) => call.text.includes('jsonb_agg'))
    expect(dataCall?.values).toEqual([
      'streamer-1',
      '2024-01-01T00:00:00Z',
      '2024-02-01T00:00:00.000Z',
      '%100\\%\\_viewer%',
      'rare',
      10,
      20,
    ])
  })

  it('getUserCardsTable はpageからoffsetを計算してPostgresへ渡す', async () => {
    const { tag, calls } = fakeSqlTag([], 0)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const { getUserCardsTable } = await importLocalAdminApi()

    await expect(
      getUserCardsTable({ userId: 'user-1', page: 2, pageSize: 15 }, {})
    ).resolves.toEqual({ rows: [], count: 0 })
    const dataCall = calls.find((call) => call.text.includes('jsonb_agg'))
    expect(dataCall?.values).toEqual(['user-1', 15, 15])
  })

  it('createSupportCode はHTTP payloadをPostgres payloadへ正規化する', async () => {
    const { tag, calls } = fakeSqlTag({ id: 'code-1', status: 'active' })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const { createSupportCode } = await importLocalAdminApi()

    await expect(
      createSupportCode(
        { code_hash: 'hash', plan_type: 'premium', memo: '' },
        {}
      )
    ).resolves.toEqual({ id: 'code-1', status: 'active' })
    expect(calls[0].values).toEqual(['hash', 'premium', null])
  })

  it('updateAnnouncement は公開トグルを限定列のPostgres更新へ変換する', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { tag, calls } = fakeSqlTag({ id: 'ann-1', is_published: false })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const { updateAnnouncement } = await importLocalAdminApi()

    await expect(
      updateAnnouncement('ann-1', { is_published: false }, {})
    ).resolves.toEqual({ id: 'ann-1', is_published: false })
    expect(calls[0].text).not.toContain('title = ')
    expect(calls[0].values).toEqual([
      false,
      '2026-01-01T00:00:00.000Z',
      'ann-1',
    ])
  })
})

describe('localAdminApi: pure helper', () => {
  it('escapeIlikePattern は LIKEの制御文字をエスケープする', async () => {
    const { escapeIlikePattern } = await importLocalAdminApi()
    expect(escapeIlikePattern('100%_off')).toBe('100\\%\\_off')
    expect(escapeIlikePattern('back\\slash')).toBe('back\\\\slash')
  })

  it('computeExclusiveToDateIso は翌日0時UTCを返す', async () => {
    const { computeExclusiveToDateIso } = await importLocalAdminApi()
    expect(computeExclusiveToDateIso('2024-01-31')).toBe(
      '2024-02-01T00:00:00.000Z'
    )
  })

  it('resolveGachaDateFilters は明示from/toをrangeより優先する', async () => {
    const { resolveGachaDateFilters } = await importLocalAdminApi()
    expect(
      resolveGachaDateFilters({
        range: '7d',
        from: '2024-01-01',
        to: '2024-01-31',
      })
    ).toEqual({
      fromDate: '2024-01-01T00:00:00Z',
      toDateExclusive: '2024-02-01T00:00:00.000Z',
    })
  })

  it('resolveGachaDateFilters はrange=allを未指定境界へ変換する', async () => {
    const { resolveGachaDateFilters } = await importLocalAdminApi()
    expect(
      resolveGachaDateFilters({ range: 'all', from: '', to: '' })
    ).toEqual({
      fromDate: undefined,
      toDateExclusive: undefined,
    })
  })
})

// localAdminApiPlugin の configureServer() 自体の回帰確認。
// 上のwrapperテストが経由しないHTTPディスパッチ層とCSV特殊経路を確認する。

/**
 * localAdminApiPlugin(env) からconfigureServer()経由でHTTPハンドラ本体を取り出す。
 * Plugin型はanalysis/node_modules/viteから解決される別物理パッケージの型のため、
 * テスト専用の最小限fake serverで済ませany経由にする。
 */
async function captureAdminApiHandler(
  env: Record<string, string>
): Promise<(req: unknown, res: unknown) => Promise<void>> {
  const { localAdminApiPlugin } = await importLocalAdminApi()
  const plugin = localAdminApiPlugin(env) as any
  const server: any = { middlewares: { use: vi.fn() } }
  plugin.configureServer(server)
  expect(server.middlewares.use).toHaveBeenCalledWith('/__admin', expect.any(Function))
  return server.middlewares.use.mock.calls[0][1]
}

// __setAnalysisSqlFactoryForTests()でsql factoryを差し替えているため、以下の
// DASHBOARD_DATABASE_URLは実際には接続に使われない。
const PG_ONLY_ENV = {
  DASHBOARD_DATABASE_URL: 'postgres://fake-host/fake-db',
}

describe('localAdminApiPlugin: Postgres専用HTTP/CSV経路', () => {
  it.each([
    ['外部アドレス', '192.0.2.1'],
    ['取得不能なアドレス', undefined],
  ])('%sからのアクセスを403にし、DBへ到達させない', async (_case, remoteAddress) => {
    const { tag, calls } = fakeSqlTag({ stats: { totalUsers: 1 } })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)
    const handler = await captureAdminApiHandler(PG_ONLY_ENV)
    const req: any = {
      method: 'GET',
      url: '/overview',
      socket: { remoteAddress },
    }
    const res: any = { setHeader: vi.fn(), end: vi.fn() }

    await handler(req, res)

    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      error: 'Admin API is only available from loopback addresses',
    })
    expect(calls).toHaveLength(0)
  })

  it('loopbackの/overviewをPostgres結果で返す', async () => {
    const { tag } = fakeSqlTag({ stats: { totalUsers: 1 } })
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)

    const handler = await captureAdminApiHandler(PG_ONLY_ENV)

    // connectのミドルウェアマウント('/__admin')によりreq.urlからは既に
    // /__adminプレフィックスが取り除かれた状態でハンドラに渡る（本体側コメント参照）
    const req: any = {
      method: 'GET',
      url: '/overview',
      socket: { remoteAddress: '127.0.0.1' },
    }
    const res: any = { setHeader: vi.fn(), end: vi.fn() }

    await handler(req, res)

    expect(res.end).toHaveBeenCalledTimes(1)
    const body = res.end.mock.calls[0][0] as string
    expect(res.statusCode).not.toBe(500)
    // ついでにpg経路が実際に動作していること（overviewの結果がpg経路のfakeから
    // 返っていること）も確認する
    expect(JSON.parse(body)).toEqual({ stats: { totalUsers: 1 } })
  })

  // /gacha/export は他ルートと違いhandleRoute()+sendJson()の汎用ディスパッチを
  // 経由せず、configureServer内で先取りしてhandleGachaExport()を直接呼ぶ別経路
  // （本体側コメント参照）。JSONとCSVの両ディスパッチを個別に回帰確認する。
  it('/gacha/exportはCSV式注入とRFC4180特殊文字を無害化する', async () => {
    const exportRows = [
      {
        redeemed_at: '2024-01-01T00:00:00Z',
        user_twitch_username: '+cmd',
        cards: { name: 'card,"quoted"', rarity: '@legendary' },
        streamers: { twitch_display_name: '=SUM(1,1)' },
      },
    ]
    const { tag } = fakeSqlTag(exportRows)
    const adminApiPg = await importAdminApiPg()
    adminApiPg.__setAnalysisSqlFactoryForTests(() => tag as never)

    const handler = await captureAdminApiHandler(PG_ONLY_ENV)

    const req: any = {
      method: 'GET',
      url: '/gacha/export',
      socket: { remoteAddress: '127.0.0.1' },
    }
    const res: any = { setHeader: vi.fn(), end: vi.fn() }

    await handler(req, res)

    expect(res.end).toHaveBeenCalledTimes(1)
    const body = res.end.mock.calls[0][0] as string
    expect(res.statusCode).toBe(200)
    expect(body).toContain('redeemed_at,streamer,username,card_name,rarity')
    expect(body).toContain('"\'=SUM(1,1)"')
    expect(body).toContain("'+cmd")
    expect(body).toContain('"card,""quoted"""')
    expect(body).toContain("'@legendary")
  })
})
