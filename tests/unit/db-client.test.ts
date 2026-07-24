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
        HYPERDRIVE_PLANETSCALE: {
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
  })

  it('Node フォールバックでも接続先未設定なら throw する', async () => {
    vi.stubEnv('DATABASE_URL', undefined)
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    await expect(getDb()).rejects.toThrow(/DATABASE_URL/)
  })
})

/**
 * stripPostgresJsIncompatibleSslParams（PlanetScale接続文字列との非互換性修正）のテスト。
 *
 * 実機で確認された事実（実PlanetScale preview接続、postgres.js 3.4.9）:
 * PlanetScaleダッシュボードが提供する接続文字列は `?sslmode=verify-full&sslrootcert=system`
 * を付与する。`sslrootcert` は postgres.js の parseOptions（node_modules/postgres/cjs/src/index.js）
 * が `defaults` に含まれないURLクエリパラメータとして扱い、そのまま `options.connection`
 * （PostgreSQLサーバーへのstartup packetセッションパラメータ）へ転写してしまうため、
 * `unrecognized configuration parameter "sslrootcert"` で接続自体が失敗する。
 */
describe('stripPostgresJsIncompatibleSslParams (PlanetScale sslrootcert非互換修正)', () => {
  beforeEach(() => {
    // 他の describe ブロックと同じく resetModules が必須: これが無いと Node
    // シングルトン（nodeSingletonHandles）が前のテストのハンドルを持ち越し、
    // このブロックの getDb() が新しい接続文字列ではなく古いハンドルを返してしまう
    // （実際にこの reset を入れ忘れて再現・特定した回帰）。
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sslrootcert のみを取り除き、既存の sslmode はそのまま残す', async () => {
    const { stripPostgresJsIncompatibleSslParams } = await importClient()
    const input =
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full&sslrootcert=system'
    const result = stripPostgresJsIncompatibleSslParams(input)
    expect(result).toBe(
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full'
    )
  })

  it('sslrootcert が無い接続文字列は完全に同一のまま返す', async () => {
    const { stripPostgresJsIncompatibleSslParams } = await importClient()
    const input = 'postgres://user:pass@db.example.com:5432/mydb?sslmode=require'
    expect(stripPostgresJsIncompatibleSslParams(input)).toBe(input)
  })

  // Major-1（Fableレビュー・セキュリティ上重大、実機検証で確認された事実）:
  // sslrootcert=system のみでsslmode未指定のURLは、sslrootcertを単純に削除しただけだと
  // postgres.jsが ssl=false（平文接続）として扱ってしまう。sslmode=verify-full を
  // 明示的に補うことで、sslrootcert=system が意図した完全な証明書検証を維持する。
  it('Major-1: sslrootcert=system のみ（sslmode無し）の場合、sslmode=verify-full を明示的に補う', async () => {
    const { stripPostgresJsIncompatibleSslParams } = await importClient()
    const input = 'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslrootcert=system'
    const result = stripPostgresJsIncompatibleSslParams(input)
    expect(result).toBe(
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full'
    )
  })

  it('Major-1: sslrootcert=system と sslmode の両方が指定されている場合、既存の sslmode を尊重し上書きしない', async () => {
    const { stripPostgresJsIncompatibleSslParams } = await importClient()
    const input =
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=require&sslrootcert=system'
    const result = stripPostgresJsIncompatibleSslParams(input)
    expect(result).toBe(
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=require'
    )
  })

  it('パース不能な接続文字列は変換をあきらめて元の文字列をそのまま返す', async () => {
    const { stripPostgresJsIncompatibleSslParams } = await importClient()
    const input = 'not a valid url at all :::'
    expect(stripPostgresJsIncompatibleSslParams(input)).toBe(input)
  })

  it('createHandle経由: sslrootcert付き接続文字列でも postgres.js の options.connection に sslrootcert が漏れず、sslmode(verify-full)は維持される', async () => {
    // Node フォールバック経路（next dev）で DATABASE_URL に sslrootcert 付き接続文字列を
    // 与え、getDb() が内部で createHandle() を呼ぶ実際の経路を通して検証する
    // （fixture直呼びだけでなく、実際に postgres() へ渡る値まで確認する）。
    vi.stubEnv(
      'DATABASE_URL',
      'postgres://user:pass@supabase-host:5432/db?sslmode=verify-full&sslrootcert=system'
    )
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    const handle = await getDb()
    const options = (handle.sql as any).options

    // 修正前はここに 'system' が残り、startup packetへ転写されて接続失敗の原因になっていた。
    expect(options.connection.sslrootcert).toBeUndefined()
    // sslmode=verify-full は postgres.js 内部で options.ssl='verify-full' に変換される
    // （証明書検証を弱めていないことの確認。'require'/'allow'/'prefer' とは異なり
    // rejectUnauthorizedを明示falseにする分岐を通らない）。
    expect(options.ssl).toBe('verify-full')
  })

  // Major-1 回帰テスト（createHandle経由、実際に postgres() へ渡る options.ssl まで確認）:
  // sslmode が付いていない sslrootcert=system 単体のURLで、修正前は options.ssl が
  // false（平文接続）になっていた（本テストがある行を参照してこの回帰を検知する）。
  it('Major-1 createHandle経由: sslrootcert=system のみ（sslmode無し）でも options.ssl が verify-full になり、平文接続へ落ちない', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@supabase-host:5432/db?sslrootcert=system')
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    const handle = await getDb()
    const options = (handle.sql as any).options

    expect(options.connection.sslrootcert).toBeUndefined()
    // 修正前はここが false（平文・非TLS接続）になっていた。sslmode を明示的に
    // 補ったことで、postgres.js の options.ssl が verify-full になることを確認する。
    expect(options.ssl).toBe('verify-full')
  })
})
