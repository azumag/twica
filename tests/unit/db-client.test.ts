/**
 * #570: db/client.ts（接続文字列の解決順・スコープ管理）のテスト
 *
 * tests/setup.ts のグローバル throw スタブを unmock して実実装を検証する。
 * postgres.js は遅延接続（初クエリまで TCP を張らない）のため、クライアント
 * 生成のみのテストでは実接続は一切発生しない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// setup.ts が登録する throw スタブを解除し、実装本体をテスト対象にする
vi.unmock('@/lib/db/client')

// Cloudflare コンテキストは環境依存のためモックで制御する。
// client.ts は動的 import で解決するが、vi.mock は動的 import にも適用される。
const mocks = vi.hoisted(() => ({
  getCloudflareContext: vi.fn(),
}))
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}))

/** モジュール状態（Node シングルトン等）をテストごとにリセットして import する */
async function importClient() {
  return await import('@/lib/db/client')
}

describe('getDb (#570 client.ts)', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
  })

  // 環境変数は vi.stubEnv で設定し vi.unstubAllEnvs で確実に復元する
  // （直接 mutation はテスト失敗時に他テストへ漏れるため）
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('Workers: HYPERDRIVE バインディングの接続文字列を最優先で使う', async () => {
    // DATABASE_URL も設定されている状態で HYPERDRIVE 側が勝つことを検証
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@local-host:5432/localdb')
    const ctx = { waitUntil: vi.fn() }
    mocks.getCloudflareContext.mockResolvedValue({
      env: {
        HYPERDRIVE_SUPABASE: {
          connectionString: 'postgres://user:pass@hyperdrive-host:5432/hyperdb',
        },
      },
      ctx,
    })

    const { getDb } = await importClient()
    const handle = await getDb()

    expect((handle.sql as any).options.host).toEqual(['hyperdrive-host'])
    expect((handle.sql as any).options.max).toBe(5)
  })

  it('Workers: 同一リクエスト（同一 ctx）ではハンドルを再利用し、別リクエストでは新規生成する', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@local-host:5432/localdb')
    const ctxA = { waitUntil: vi.fn() }
    const ctxB = { waitUntil: vi.fn() }
    mocks.getCloudflareContext.mockResolvedValue({ env: {}, ctx: ctxA })

    const { getDb } = await importClient()
    const first = await getDb()
    const second = await getDb()
    expect(second).toBe(first)

    // 別リクエスト（別の ExecutionContext）では新しいハンドル
    mocks.getCloudflareContext.mockResolvedValue({ env: {}, ctx: ctxB })
    const third = await getDb()
    expect(third).not.toBe(first)
  })

  it('Node フォールバック: getCloudflareContext が throw したら DATABASE_URL のシングルトンを使う', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@dev-host:5432/devdb')
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    const first = await getDb()
    const second = await getDb()

    expect((first.sql as any).options.host).toEqual(['dev-host'])
    // Node ではモジュールシングルトン（同一ハンドル再利用）
    expect(second).toBe(first)
  })

  it('接続先が未設定（HYPERDRIVE なし・DATABASE_URL なし）なら文脈が分かるメッセージで throw する', async () => {
    vi.stubEnv('DATABASE_URL', undefined)
    mocks.getCloudflareContext.mockResolvedValue({ env: {}, ctx: { waitUntil: vi.fn() } })

    const { getDb } = await importClient()
    await expect(getDb()).rejects.toThrow(/HYPERDRIVE|DATABASE_URL/)
    // postgrest へ戻す手段（DB_DRIVER を外す）がメッセージから分かること
    await expect(getDb()).rejects.toThrow(/DB_DRIVER/)
  })

  it('Node フォールバックでも接続先未設定なら throw する', async () => {
    vi.stubEnv('DATABASE_URL', undefined)
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    await expect(getDb()).rejects.toThrow(/DATABASE_URL/)
  })
})

/**
 * #693 (Phase 2 dual Hyperdrive binding / DB_TARGET 切替) 用のテスト。
 *
 * 最重要の回帰確認: DB_TARGET が一切設定されていない状態で、引数無し getDb() を
 * 呼ぶ既存の全呼び出し元（src/lib/services/gacha.ts 等）が、#693 以前と全く同じ
 * バインディング（HYPERDRIVE_SUPABASE）・接続先解決ロジックへ到達すること。
 * これは上の describe ブロックの各テスト（DB_TARGET を一切 stub していない）が
 * 既に検証している内容と同一の経路だが、「target 別キャッシュ導入後も同じ経路が
 * 生きている」ことを本セクションでも明示的に再確認する。
 */
describe('getDb target resolution (#693 Phase 2)', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('DB_TARGET 未設定・引数無し getDb() は HYPERDRIVE_SUPABASE バインディングを参照する（既存呼び出し元の回帰確認）', async () => {
    // DB_TARGET が「テスト実行環境に元々存在しない」ことに暗黙依存しないよう、
    // 明示的に未設定へ stub する（tests/unit/db-target.test.ts と同じ方針。
    // CI環境が将来 DB_TARGET を export するようになっても、このテストの意味
    // 「未設定時はsupabase」が変わらないようにするため）。
    vi.stubEnv('DB_TARGET', undefined)
    const ctx = { waitUntil: vi.fn() }
    mocks.getCloudflareContext.mockResolvedValue({
      env: {
        HYPERDRIVE_SUPABASE: {
          connectionString: 'postgres://user:pass@supabase-host:5432/db',
        },
        // planetscale 側 binding が存在しても、target 未指定（=supabase）では
        // 参照されないことも同時に確認する。
        HYPERDRIVE_PLANETSCALE: {
          connectionString: 'postgres://user:pass@planetscale-host:5432/db',
        },
      },
      ctx,
    })

    const { getDb } = await importClient()
    const handle = await getDb()

    expect((handle.sql as any).options.host).toEqual(['supabase-host'])
  })

  it('DB_TARGET=planetscale なら HYPERDRIVE_PLANETSCALE バインディングを使う', async () => {
    vi.stubEnv('DB_TARGET', 'planetscale')
    const ctx = { waitUntil: vi.fn() }
    mocks.getCloudflareContext.mockResolvedValue({
      env: {
        HYPERDRIVE_SUPABASE: {
          connectionString: 'postgres://user:pass@supabase-host:5432/db',
        },
        HYPERDRIVE_PLANETSCALE: {
          connectionString: 'postgres://user:pass@planetscale-host:5432/db',
        },
      },
      ctx,
    })

    const { getDb } = await importClient()
    const handle = await getDb()

    expect((handle.sql as any).options.host).toEqual(['planetscale-host'])
  })

  it('resolveConnectionString の優先順位: target別 binding > target別 DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL_PLANETSCALE', 'postgres://user:pass@ps-env-host:5432/db')
    const ctx = { waitUntil: vi.fn() }
    mocks.getCloudflareContext.mockResolvedValue({
      env: {
        HYPERDRIVE_PLANETSCALE: {
          connectionString: 'postgres://user:pass@ps-binding-host:5432/db',
        },
      },
      ctx,
    })

    const { getDb } = await importClient()
    const handle = await getDb({ target: 'planetscale' })

    expect((handle.sql as any).options.host).toEqual(['ps-binding-host'])
  })

  it('resolveConnectionString の優先順位（supabase）: target別 DATABASE_URL_SUPABASE > レガシー DATABASE_URL', async () => {
    // Hyperdrive binding が無い（Node フォールバック）状態で、(2) DATABASE_URL_SUPABASE と
    // (3) レガシー DATABASE_URL の両方が設定されている場合に (2) が優先されることを確認する。
    // supabase 以外の target（planetscale）で同種の優先順位は既存テスト（binding > target別
    // DATABASE_URL）でカバー済みだが、(2) vs (3) の優先順位は supabase target 特有の分岐
    // （resolveConnectionString の legacy DATABASE_URL フォールバックは target==='supabase'
    // の場合のみ到達する）のため、このテストが無いと (2) の分岐が (3) より先に評価される
    // ことを検証できていなかった。
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@legacy-supabase-host:5432/db')
    vi.stubEnv('DATABASE_URL_SUPABASE', 'postgres://user:pass@supabase-env-host:5432/db')
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    const handle = await getDb({ target: 'supabase' })

    expect((handle.sql as any).options.host).toEqual(['supabase-env-host'])
  })

  it('planetscale ターゲットは binding も DATABASE_URL_PLANETSCALE も無ければ、DATABASE_URL が設定されていても throw する（誤って旧接続先へ落ちない）', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@legacy-supabase-host:5432/db')
    mocks.getCloudflareContext.mockResolvedValue({ env: {}, ctx: { waitUntil: vi.fn() } })

    const { getDb } = await importClient()
    let caught: unknown
    try {
      await getDb({ target: 'planetscale' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('HYPERDRIVE_PLANETSCALE')
    expect(message).toContain('DATABASE_URL_PLANETSCALE')
    // DATABASE_URL（レガシー）にフォールバックしない: エラーメッセージに legacy
    // DATABASE_URL への言及（supabase 向けの ' or DATABASE_URL (local dev)' 文言）が
    // 含まれないことで、fail-closed（誤って旧接続先の存在を示唆しない）ことを確認する。
    expect(message).not.toContain('or DATABASE_URL (local dev)')
  })

  it('planetscale ターゲットは DATABASE_URL_PLANETSCALE があれば接続できる（DATABASE_URL とは独立）', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@legacy-supabase-host:5432/db')
    vi.stubEnv('DATABASE_URL_PLANETSCALE', 'postgres://user:pass@ps-dev-host:5432/db')
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    const handle = await getDb({ target: 'planetscale' })

    expect((handle.sql as any).options.host).toEqual(['ps-dev-host'])
  })

  it('Workers: 同一リクエスト内で target ごとにハンドルが分かれ、混ざらない', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@supabase-host:5432/db')
    vi.stubEnv('DATABASE_URL_PLANETSCALE', 'postgres://user:pass@ps-host:5432/db')
    const ctx = { waitUntil: vi.fn() }
    mocks.getCloudflareContext.mockResolvedValue({ env: {}, ctx })

    const { getDb } = await importClient()
    const supabaseHandle = await getDb({ target: 'supabase' })
    const planetscaleHandle = await getDb({ target: 'planetscale' })
    const supabaseHandleAgain = await getDb({ target: 'supabase' })

    expect(supabaseHandle).not.toBe(planetscaleHandle)
    expect((supabaseHandle.sql as any).options.host).toEqual(['supabase-host'])
    expect((planetscaleHandle.sql as any).options.host).toEqual(['ps-host'])
    // 同一 target・同一リクエストでは再利用される
    expect(supabaseHandleAgain).toBe(supabaseHandle)
  })

  it('Node: target ごとに独立したシングルトンを保持する', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@supabase-host:5432/db')
    vi.stubEnv('DATABASE_URL_PLANETSCALE', 'postgres://user:pass@ps-host:5432/db')
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    const supabaseHandle1 = await getDb({ target: 'supabase' })
    const planetscaleHandle1 = await getDb({ target: 'planetscale' })
    const supabaseHandle2 = await getDb({ target: 'supabase' })
    const planetscaleHandle2 = await getDb({ target: 'planetscale' })

    expect(supabaseHandle1).not.toBe(planetscaleHandle1)
    expect(supabaseHandle2).toBe(supabaseHandle1)
    expect(planetscaleHandle2).toBe(planetscaleHandle1)
  })
})
