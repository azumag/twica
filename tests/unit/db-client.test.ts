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
      env: { HYPERDRIVE: { connectionString: 'postgres://user:pass@hyperdrive-host:5432/hyperdb' } },
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
