/**
 * #663: support-inquiries データアクセス層の postgrest 経路 / pg 経路の互換テスト
 *
 * tests/unit/announcements-driver-parity.test.ts と同じ流儀。
 * 同一 fixture を両経路のモックに与え、戻り値が deepEqual であることと、
 * エラー系（取得失敗・0行）の外部挙動が一致することを検証する。
 *
 * 日付の扱い（実装コメント参照）:
 * - getUserInquiries は消費側が Server Component のサーバー側 new Date() のみの
 *   ため生文字列をそのまま返す（dashboard-data.ts の方針）。
 * - getInquiryWithMessages はクライアントコンポーネント（InquiryThread.tsx）へ
 *   日付文字列が渡りブラウザ側で new Date() されるため、pg 経路では
 *   normalizePgTimestamp で ISO 8601 へ正規化する。fixture に ISO 8601（Z 終端）を
 *   使うと正規化は恒等変換になり、両経路の deepEqual 比較がそのまま成立する。
 *   PG テキスト形式 → ISO への正規化は専用のテストで別途検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { and, asc, desc, eq } from 'drizzle-orm'
import {
  getUserInquiries,
  getInquiryWithMessages,
  normalizePgTimestamp,
} from '@/lib/support-inquiries'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import {
  supportInquiries as supportInquiriesTable,
  supportInquiryMessages as supportInquiryMessagesTable,
} from '@/lib/db/schema'

// logger.error → logErrorFromLogger 経由の Supabase 書き込み（エラー系テストでの
// ノイズ・余計な副作用）を抑止する（support-inquiries-api.test.ts と同じモック）
vi.mock('@/lib/sentry/error-handler', () => ({
  reportError: vi.fn(),
  reportApiError: vi.fn(),
  logErrorFromLogger: vi.fn(),
}))

// ---------------------------------------------------------------------------
// 共通 fixture（両経路に同じ行データを与える）
// 日付は ISO 8601（Z 終端）: normalizePgTimestamp(x) === x となる形式のため
// 「正規化あり（pg）/ なし（postgrest）」の両経路がそのまま deepEqual になる
// ---------------------------------------------------------------------------

const USER_ID = 'user123'
const INQUIRY_ID = '550e8400-e29b-41d4-a716-446655440000'

const INQUIRY_ROW = {
  id: INQUIRY_ID,
  twitch_user_id: USER_ID,
  twitch_display_name: 'TestUser',
  category: 'bug',
  subject: 'テストバグ',
  body: 'バグの説明',
  status: 'open',
  created_at: '2026-01-02T03:04:05.000Z',
  updated_at: '2026-01-03T04:05:06.000Z',
}

const MESSAGE_ROWS = [
  {
    id: 'msg-1',
    inquiry_id: INQUIRY_ID,
    sender_type: 'user',
    sender_id: USER_ID,
    body: '追記です',
    created_at: '2026-01-04T05:06:07.000Z',
  },
  {
    id: 'msg-2',
    inquiry_id: INQUIRY_ID,
    sender_type: 'admin',
    sender_id: 'admin',
    body: '確認しました',
    created_at: '2026-01-05T06:07:08.000Z',
  },
]

/** pg 直結が返す PG テキスト形式のタイムスタンプ（正規化テスト用） */
const PG_TEXT_TIMESTAMP = '2026-01-02 03:04:05.123456+00'
const PG_TEXT_TIMESTAMP_ISO = '2026-01-02T03:04:05.123Z'

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from() 呼び出しごとに応答キューを消費する thenable builder
// （select/eq/order のチェーン + .single() の両形態に対応）
// ---------------------------------------------------------------------------

interface SupabaseResponse {
  data?: unknown
  error?: unknown
}

function createSupabaseClientMock(responses: SupabaseResponse[]) {
  let index = 0
  const from = vi.fn(() => {
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    const result = { data: response.data ?? null, error: response.error ?? null }
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      order: vi.fn(() => builder),
      single: vi.fn(() => Promise.resolve(result)),
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return builder
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック（announcements/sub-check の parity テストと同方式）:
// select(fields).from().where().orderBy()/.limit() を await できる thenable builder。
// 実 Drizzle と同様「select で指定された列だけ」を fixture 行から射影して返し、
// where/orderBy/limit の実引数を記録して構造比較できるようにする。
// ---------------------------------------------------------------------------

interface PgSelectCall {
  table?: unknown
  where?: unknown
  orderBy?: unknown
  limit?: number
}

function createDrizzleDbMock(config: {
  selects?: Array<{ rows?: Array<Record<string, unknown>>; error?: unknown }>
} = {}) {
  let selectIndex = 0
  const selectCalls: PgSelectCall[] = []

  const db = {
    select: vi.fn((fields: Record<string, unknown>) => {
      const responses = config.selects ?? [{ rows: [] }]
      const response = responses[Math.min(selectIndex, responses.length - 1)]
      selectIndex += 1
      const call: PgSelectCall = {}
      selectCalls.push(call)
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        from: vi.fn((table: unknown) => {
          call.table = table
          return builder
        }),
        where: vi.fn((condition: unknown) => {
          call.where = condition
          return builder
        }),
        orderBy: vi.fn((condition: unknown) => {
          call.orderBy = condition
          return builder
        }),
        limit: vi.fn((n: number) => {
          call.limit = n
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }
  return { db, selectCalls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: mock.db, sql: {} } as any)
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('support-inquiries: postgrest / pg 経路の互換 (#663)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 環境変数は vi.stubEnv で設定し必ず復元する（announcements parity テストと
  // 同じ理由: process.env の直接 mutation はテスト失敗時に他テストへ漏れる）
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('normalizePgTimestamp', () => {
    it('PG テキスト形式を ISO 8601 に正規化する', () => {
      expect(normalizePgTimestamp(PG_TEXT_TIMESTAMP)).toBe(PG_TEXT_TIMESTAMP_ISO)
    })

    it('ISO 8601（Z 終端）は恒等変換になる', () => {
      expect(normalizePgTimestamp('2026-01-02T03:04:05.000Z')).toBe('2026-01-02T03:04:05.000Z')
    })

    it('PostgREST 形式（+00:00 オフセット）も同一時刻の ISO 8601 になる', () => {
      expect(normalizePgTimestamp('2026-01-02T03:04:05.123456+00:00')).toBe(
        '2026-01-02T03:04:05.123Z'
      )
    })

    it('null は null、パース不能な文字列は元の値をそのまま返す', () => {
      expect(normalizePgTimestamp(null)).toBeNull()
      expect(normalizePgTimestamp('not-a-date')).toBe('not-a-date')
    })
  })

  describe('getUserInquiries', () => {
    it('同一 fixture で両経路の戻り値が deepEqual になる', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: [INQUIRY_ROW] }])
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getUserInquiries(USER_ID)

      // 読み取り専用の関数のため pg-read で pg 経路に切り替わる
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selects: [{ rows: [INQUIRY_ROW] }] })
      primePgDb(pg)
      const pgResult = await getUserInquiries(USER_ID)

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual([INQUIRY_ROW])

      // where/orderBy の実引数（絞り込み・ソートの取り違え検知）
      expect(pg.selectCalls).toHaveLength(1)
      expect(pg.selectCalls[0].table).toBe(supportInquiriesTable)
      expect(pg.selectCalls[0].where).toEqual(eq(supportInquiriesTable.twitch_user_id, USER_ID))
      expect(pg.selectCalls[0].orderBy).toEqual(desc(supportInquiriesTable.created_at))
    })

    it('pg 経路は日付を正規化せず生文字列のまま返す（サーバー側消費のみのため）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [{ ...INQUIRY_ROW, created_at: PG_TEXT_TIMESTAMP }] }],
      })
      primePgDb(pg)

      const result = await getUserInquiries(USER_ID)
      expect(result[0].created_at).toBe(PG_TEXT_TIMESTAMP)
    })

    it('取得エラー時は両経路とも空配列', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ error: { message: 'boom' } }])
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await expect(getUserInquiries(USER_ID)).resolves.toEqual([])

      vi.stubEnv('DB_DRIVER', 'pg-read')
      // 恒久的エラー（構文エラー相当）: withDbRetry はリトライせず throw → catch → []
      const pg = createDrizzleDbMock({
        selects: [{ error: { code: '42601', message: 'syntax error' } }],
      })
      primePgDb(pg)
      await expect(getUserInquiries(USER_ID)).resolves.toEqual([])
    })

    it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([{ data: [INQUIRY_ROW] }])
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      await expect(getUserInquiries(USER_ID)).resolves.toEqual([INQUIRY_ROW])
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  describe('getInquiryWithMessages', () => {
    it('同一 fixture で両経路の戻り値が deepEqual になる（クエリ実引数も検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([
        { data: INQUIRY_ROW }, // inquiry (.single())
        { data: MESSAGE_ROWS }, // messages
      ])
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getInquiryWithMessages(INQUIRY_ID, USER_ID)

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({
        selects: [{ rows: [INQUIRY_ROW] }, { rows: MESSAGE_ROWS }],
      })
      primePgDb(pg)
      const pgResult = await getInquiryWithMessages(INQUIRY_ID, USER_ID)

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({ inquiry: INQUIRY_ROW, messages: MESSAGE_ROWS })

      // inquiry: 所有権チェック込みの where + PRIMARY KEY 根拠の limit(1)
      expect(pg.selectCalls[0].table).toBe(supportInquiriesTable)
      expect(pg.selectCalls[0].where).toEqual(
        and(
          eq(supportInquiriesTable.id, INQUIRY_ID),
          eq(supportInquiriesTable.twitch_user_id, USER_ID)
        )
      )
      expect(pg.selectCalls[0].limit).toBe(1)
      // messages: inquiry_id 絞り込み + created_at 昇順
      expect(pg.selectCalls[1].table).toBe(supportInquiryMessagesTable)
      expect(pg.selectCalls[1].where).toEqual(
        eq(supportInquiryMessagesTable.inquiry_id, INQUIRY_ID)
      )
      expect(pg.selectCalls[1].orderBy).toEqual(asc(supportInquiryMessagesTable.created_at))
    })

    it('pg 経路は PG テキスト形式の日付を ISO 8601 に正規化して返す（ブラウザへ渡るため）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [
          {
            rows: [
              { ...INQUIRY_ROW, created_at: PG_TEXT_TIMESTAMP, updated_at: PG_TEXT_TIMESTAMP },
            ],
          },
          { rows: [{ ...MESSAGE_ROWS[0], created_at: PG_TEXT_TIMESTAMP }] },
        ],
      })
      primePgDb(pg)

      const result = await getInquiryWithMessages(INQUIRY_ID, USER_ID)
      expect(result?.inquiry.created_at).toBe(PG_TEXT_TIMESTAMP_ISO)
      expect(result?.inquiry.updated_at).toBe(PG_TEXT_TIMESTAMP_ISO)
      expect(result?.messages[0].created_at).toBe(PG_TEXT_TIMESTAMP_ISO)
    })

    it('0 行（存在しない / 他ユーザーの問い合わせ）は両経路とも null', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      // .single() は 0 行でエラーを返す（PostgREST の外部挙動）
      const client = createSupabaseClientMock([
        { data: null, error: { code: 'PGRST116', message: '0 rows' } },
      ])
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await expect(getInquiryWithMessages(INQUIRY_ID, USER_ID)).resolves.toBeNull()

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ selects: [{ rows: [] }] })
      primePgDb(pg)
      await expect(getInquiryWithMessages(INQUIRY_ID, USER_ID)).resolves.toBeNull()
    })

    it('問い合わせ取得エラー（不正 UUID の 22P02 等）は両経路とも null', async () => {
      vi.stubEnv('DB_DRIVER', 'pg')
      const pg = createDrizzleDbMock({
        selects: [{ error: { code: '22P02', message: 'invalid input syntax for type uuid' } }],
      })
      primePgDb(pg)
      await expect(getInquiryWithMessages('not-a-uuid', USER_ID)).resolves.toBeNull()
    })

    it('メッセージ取得エラー時は両経路とも { inquiry, messages: [] } を返す', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([
        { data: INQUIRY_ROW },
        { data: null, error: { message: 'boom' } },
      ])
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getInquiryWithMessages(INQUIRY_ID, USER_ID)

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({
        selects: [
          { rows: [INQUIRY_ROW] },
          { error: { code: '42601', message: 'syntax error' } },
        ],
      })
      primePgDb(pg)
      const pgResult = await getInquiryWithMessages(INQUIRY_ID, USER_ID)

      expect(pgResult).toEqual(postgrestResult)
      expect(pgResult).toEqual({ inquiry: INQUIRY_ROW, messages: [] })
    })

    it('フラグ未設定時は getDb が一切呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock([
        { data: INQUIRY_ROW },
        { data: MESSAGE_ROWS },
      ])
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      await getInquiryWithMessages(INQUIRY_ID, USER_ID)
      expect(getDb).not.toHaveBeenCalled()
    })
  })
})
