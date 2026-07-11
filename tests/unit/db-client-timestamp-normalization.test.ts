/**
 * Issue #688: pg 直結（postgres.js + Drizzle）経路の timestamp/timestamptz を
 * ISO 8601 に正規化する実装（src/lib/db/client.ts）のテスト。
 *
 * tests/unit/db-client.test.ts と同じ流儀（setup.ts のグローバル throw スタブを
 * unmock して実装本体を検証する / Cloudflare コンテキストはモックで制御する /
 * getDb() 呼び出し前提のテストは vi.resetModules() でモジュール状態をリセットする）
 * を踏襲する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// setup.ts が登録する throw スタブを解除し、実装本体をテスト対象にする
vi.unmock('@/lib/db/client')

// Cloudflare コンテキストは環境依存のためモックで制御する（db-client.test.ts と同じ）。
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

// ---------------------------------------------------------------------------
// normalizePgTimestampString: 純関数の網羅的単体テスト
// ---------------------------------------------------------------------------
describe('normalizePgTimestampString (#688)', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('変換対象（PG テキスト形式 → ISO 8601）', () => {
    const cases: Array<[label: string, input: string, expected: string]> = [
      [
        'オフセット無し（timestamp without time zone, OID 1114）: T区切りのみでオフセットを付けない',
        '2024-01-01 12:00:00.123456',
        '2024-01-01T12:00:00.123456',
      ],
      ['オフセット +00（2桁）→ +00:00 に補完', '2024-01-01 12:00:00.123456+00', '2024-01-01T12:00:00.123456+00:00'],
      ['オフセット -05（2桁）→ -05:00 に補完', '2024-01-01 12:00:00.123456-05', '2024-01-01T12:00:00.123456-05:00'],
      [
        'オフセット +09:30（分単位）はそのまま維持',
        '2024-01-01 12:00:00.123456+09:30',
        '2024-01-01T12:00:00.123456+09:30',
      ],
      ['小数秒0桁（整数秒、オフセット無し）', '2024-01-01 12:00:00', '2024-01-01T12:00:00'],
      ['小数秒0桁 + オフセットあり', '2024-01-01 12:00:00+00', '2024-01-01T12:00:00+00:00'],
      ['小数秒1桁（PGの末尾ゼロ削り形）', '2024-01-01 12:00:00.1+00', '2024-01-01T12:00:00.1+00:00'],
      ['小数秒2桁', '2024-01-01 12:00:00.12+00', '2024-01-01T12:00:00.12+00:00'],
      ['小数秒3桁', '2024-01-01 12:00:00.123+00', '2024-01-01T12:00:00.123+00:00'],
      ['小数秒4桁', '2024-01-01 12:00:00.1234+00', '2024-01-01T12:00:00.1234+00:00'],
      ['小数秒5桁', '2024-01-01 12:00:00.12345+00', '2024-01-01T12:00:00.12345+00:00'],
      ['小数秒6桁（フル精度）', '2024-01-01 12:00:00.123456+00', '2024-01-01T12:00:00.123456+00:00'],
    ]

    it.each(cases)('%s', async (_label, input, expected) => {
      const { normalizePgTimestampString } = await importClient()
      expect(normalizePgTimestampString(input)).toBe(expected)
    })
  })

  describe('パススルー対象（安全側で無変換）', () => {
    const cases: Array<[label: string, input: string]> = [
      ['±HH:MM:SS 形式の歴史的オフセット（ISO 8601 非準拠）', '1892-01-01 00:00:00+09:18:59'],
      ['infinity', 'infinity'],
      ['-infinity', '-infinity'],
      ['BC 日付', '0001-01-01 00:00:00+00 BC'],
      ['空文字列', ''],
      ['タイムスタンプでない文字列', 'not-a-timestamp'],
      ['既に ISO 8601 形式の文字列（T区切り・冪等性の確認）', '2024-01-01T12:00:00.123456+00:00'],
      ['日付のみ（date 列 OID 1082 相当。この関数の対象外）', '2024-01-01'],
    ]

    it.each(cases)('%s: 無変換のまま返す', async (_label, input) => {
      const { normalizePgTimestampString } = await importClient()
      expect(normalizePgTimestampString(input)).toBe(input)
    })
  })

  // -------------------------------------------------------------------------
  // epoch 等価性プロパティテスト
  //
  // ISO 8601 の Date Time String Format（ECMA-262 21.4.1.15）は「オフセット省略時、
  // 日付のみの形式は UTC・日付時刻形式はローカル時刻として解釈する」と定めている。
  // PG テキスト形式（スペース区切り）・正規化後の ISO 8601（T区切り）はいずれも
  // 「日付時刻形式でオフセット省略時はローカル時刻」というこの規則に従って V8 に
  // 解釈されるため、実行環境のタイムゾーンに関わらず両者は常に同一時刻に評価される
  // （実行環境依存の不安定なテストにはならない）。
  // -------------------------------------------------------------------------
  describe('epoch 等価性（変換前後で同一時刻を指すこと）', () => {
    const convertibleInputs = [
      '2024-01-01 12:00:00.123456',
      '2024-01-01 12:00:00.123456+00',
      '2024-01-01 12:00:00.123456-05',
      '2024-01-01 12:00:00.123456+09:30',
      '2024-01-01 12:00:00',
      '2024-01-01 12:00:00.1+00',
      '2024-01-01 12:00:00.12+00',
      '2026-01-01 00:00:01.654321+00',
    ]

    it.each(convertibleInputs)('%s は正規化後も new Date().getTime() が変化しない', async (input) => {
      const { normalizePgTimestampString } = await importClient()
      const normalized = normalizePgTimestampString(input)
      expect(normalized).not.toBe(input) // 変換が実際に行われていることの前提確認
      expect(new Date(normalized).getTime()).toBe(new Date(input).getTime())
    })
  })
})

// ---------------------------------------------------------------------------
// installIsoTimestampParsers: オブジェクト同一性テスト（最重要）
//
// #688 の実装で最も壊れやすいのは「sql.options.parsers を丸ごと新しいオブジェクトで
// 差し替えてしまう」バグ（postgres.js の各 Connection が options.parsers の
// オブジェクト参照をコンストラクト時にクロージャで捕まえるため、差し替えると
// 正規化がサイレントに効かなくなる。根拠は src/lib/db/client.ts の
// installIsoTimestampParsers 自身のコメント参照）。
// このテストは fake client を使い、(a) options.parsers が同一オブジェクトのまま
// であること（Object.is）、(b) 対象 OID のエントリが正規化関数に置き換わっている
// ことを検証し、オブジェクト差し替えバグを確実に検出できるようにする。
// ---------------------------------------------------------------------------
describe('installIsoTimestampParsers (#688): オブジェクト同一性', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('options.parsers オブジェクトの参照を保ったまま 1114/1184 のみプロパティ単位で書き換える', async () => {
    const { installIsoTimestampParsers, normalizePgTimestampString } = await importClient()

    // drizzle() 適用後を模した状態: 対象 OID はすべて透過パーサ（構造だけ模倣）
    const transparentParser = (value: string) => value
    const originalUnrelatedParser = (value: string) => `unrelated:${value}`
    const parsersObject: Record<number, (value: string) => unknown> = {
      1082: transparentParser, // date（対象外のまま残ることの確認用）
      1114: transparentParser, // timestamp（対象）
      1184: transparentParser, // timestamptz（対象）
      23: originalUnrelatedParser, // int4 相当のダミー（無関係な OID が壊れないことの確認用）
    }
    const fakeClient = { options: { parsers: parsersObject } }

    installIsoTimestampParsers(fakeClient)

    // (a) オブジェクト自体は差し替えられていない（同一参照であること）
    expect(Object.is(fakeClient.options.parsers, parsersObject)).toBe(true)

    // (b) 対象 OID のみ正規化関数に置き換わっている
    expect(fakeClient.options.parsers[1114]).toBe(normalizePgTimestampString)
    expect(fakeClient.options.parsers[1184]).toBe(normalizePgTimestampString)

    // 無関係な OID のエントリはそのまま（プロパティ単位の書き換えであることの証跡）
    expect(fakeClient.options.parsers[1082]).toBe(transparentParser)
    expect(fakeClient.options.parsers[23]).toBe(originalUnrelatedParser)

    // 置き換わった関数が実際に正規化として機能すること
    expect(fakeClient.options.parsers[1184]('2024-01-01 12:00:00.123456+00')).toBe(
      '2024-01-01T12:00:00.123456+00:00'
    )
    expect(fakeClient.options.parsers[1114]('2024-01-01 12:00:00.123456')).toBe('2024-01-01T12:00:00.123456')
  })
})

// ---------------------------------------------------------------------------
// drizzle 上書き打ち消しテスト
//
// drizzle-orm 0.45.2 の construct()（drizzle-orm/postgres-js/driver.cjs の
// construct() 実装）は client.options.parsers の OID 1114/1184 を含む複数 OID を
// 透過パーサで in-place 上書きする。createHandle() は drizzle(sql, { schema }) の
// 「後」に installIsoTimestampParsers(sql) を呼ぶことで、この上書きを打ち消して
// 正規化パーサを最終的に有効にしている。ここでは実際の getDb() の戻り値
// （実装コードパスそのもの）に対してこれを検証する。
//
// DATABASE_URL にはダミーの postgres:// URL を使う。postgres.js は遅延接続
// （初回クエリ発行まで実際の TCP 接続を張らない）ため、getDb() を呼ぶだけでは
// 実接続は一切発生しない（db-client.test.ts の既存テストと同じ前提）。
// ---------------------------------------------------------------------------
describe('getDb() (#688): drizzle() のパーサ上書きが正規化パーサで打ち消されていること', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.getCloudflareContext.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('Node フォールバック経路で取得した sql.options.parsers[1184]/[1114] が ISO 8601 を返す', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@dummy-host:5432/dummydb')
    mocks.getCloudflareContext.mockRejectedValue(new Error('not in cloudflare context'))

    const { getDb } = await importClient()
    const { sql } = await getDb()

    // drizzle() が直後に transparentParser で 1114/1184 を上書きしても、
    // createHandle() 内で drizzle() の後に呼ばれる installIsoTimestampParsers()
    // により最終的には正規化パーサになっていること。
    const parsers = (sql as unknown as { options: { parsers: Record<number, (value: string) => unknown> } })
      .options.parsers

    expect(parsers[1184]('2024-01-01 12:00:00.123456+00')).toBe('2024-01-01T12:00:00.123456+00:00')
    expect(parsers[1114]('2024-01-01 12:00:00.123456')).toBe('2024-01-01T12:00:00.123456')

    // date(1082) は drizzle() の透過パーサのまま（#688 の対象外。無変換で通ること）
    expect(parsers[1082]('2024-01-01')).toBe('2024-01-01')
  })
})
