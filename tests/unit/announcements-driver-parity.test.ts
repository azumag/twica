/**
 * #570 パイロット: getUnreadAnnouncements の postgrest 経路 / pg 経路の形状互換テスト
 *
 * 同一 fixture を両経路のモックに与え、戻り値が deepEqual であることを検証する。
 * pg 経路（Drizzle）は PostgREST 経路と「完全に同じ戻り値形状（snake_case キー、
 * 日付は文字列）」を返すことが Phase 1 の要件（呼び出し側は経路を意識しない）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { getUnreadAnnouncements, getAllAnnouncements } from '@/lib/announcements'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import {
  announcementReads as announcementReadsTable,
  announcements as announcementsTable,
} from '@/lib/db/schema'

// ---------------------------------------------------------------------------
// 共通 fixture（両経路に同じ行データを与える）
// 実時刻に依存しないよう、過去/未来の判定は十分に離れた日時を使う
// ---------------------------------------------------------------------------

/**
 * announcements テーブルの行（SELECT 対象列のみ。日付は PostgREST が返す文字列形式）
 *
 * 注意（#688 で更新）: #688 以降、pg 直結の timestamptz は src/lib/db/client.ts の
 * installIsoTimestampParsers() により接続確立時に ISO 8601 へ正規化されるため、
 * PostgREST 経路と表現形式が一致する（正規化前は PG テキスト形式
 * '2026-03-10 12:00:00.123456+00' だった）。このモック自体は getDb() を丸ごと
 * 差し替えており src/lib/db/client.ts の正規化パーサを経由しないため、両経路に
 * 同一の ISO 8601 文字列を与えることで形式一致後の状態を再現している
 * （実装側の根拠は src/lib/announcements.ts のコメント参照）。
 * 正規化パーサ自体の単体テストは tests/unit/db-client-timestamp-normalization.test.ts、
 * 実機確認は preview 検証（docs/db-driver-migration.md）に委ねる。
 */
const ANNOUNCEMENT_ROWS = [
  {
    // 表示対象: 公開中・期限内・未読
    id: 'a1',
    title: '新機能のお知らせ',
    body: 'ガチャ演出を刷新しました',
    severity: 'info',
    // #663 Category A: getAllAnnouncements の select 対象列（is_published）。
    // is_published(既読/未読バナー側)selectには含まれないが、fixture 行に持たせても
    // getUnreadAnnouncementsPg 側は select(fields) の projection でキーを絞るため無害。
    is_published: true,
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: '2999-01-01T00:00:00.000+00:00',
    created_at: '2020-01-02T00:00:00.000+00:00',
  },
  {
    // 既読のため未読バナーからは除外される（履歴では is_read: true で表示対象）
    id: 'a2',
    title: 'メンテナンスのお知らせ',
    body: '深夜にメンテナンスを行います',
    severity: 'warning',
    is_published: true,
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: null,
    created_at: '2020-01-01T00:00:00.000+00:00',
  },
  {
    // 期限切れ: 未読バナーからは除外されるが、履歴（getAllAnnouncements）は
    // hasAnnouncementBeenPublishedAt を使い expires_at を見ないため表示対象になる
    id: 'a3',
    title: '過去のお知らせ',
    body: '終了済みキャンペーン',
    severity: 'info',
    is_published: true,
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: '2020-02-01T00:00:00.000+00:00',
    created_at: '2019-12-31T00:00:00.000+00:00',
  },
  {
    // 公開予定（未来）のため両方から除外される
    id: 'a4',
    title: '未来のお知らせ',
    body: 'まだ見えないはず',
    severity: 'critical',
    is_published: true,
    published_at: '2999-01-01T00:00:00.000+00:00',
    expires_at: null,
    created_at: '2019-12-30T00:00:00.000+00:00',
  },
  {
    // published_at が NULL（即時公開扱い）: null がそのまま返ることの検証用
    id: 'a5',
    title: '公開日時なしのお知らせ',
    body: 'published_at は null',
    severity: 'info',
    is_published: true,
    published_at: null,
    expires_at: null,
    created_at: '2019-12-29T00:00:00.000+00:00',
  },
]

/**
 * announcement_reads テーブルの行（a2 のみ既読）。
 * read_at は getAllAnnouncements（履歴ページ）のみが参照する列。
 * getUnreadAnnouncementsPg は announcement_id のみ select するため無害。
 */
const READ_ROWS = [{ announcement_id: 'a2', read_at: '2020-01-05T00:00:00.000+00:00' }]

/** 両経路が返すべき期待値（a1 と a5 が未読・表示対象） */
const EXPECTED = [
  {
    id: 'a1',
    title: '新機能のお知らせ',
    body: 'ガチャ演出を刷新しました',
    severity: 'info',
    published_at: '2020-01-01T00:00:00.000+00:00',
    created_at: '2020-01-02T00:00:00.000+00:00',
  },
  {
    id: 'a5',
    title: '公開日時なしのお知らせ',
    body: 'published_at は null',
    severity: 'info',
    published_at: null,
    created_at: '2019-12-29T00:00:00.000+00:00',
  },
]

/**
 * getAllAnnouncements（履歴ページ）が両経路で返すべき期待値。
 * a4（未来公開）のみ除外。a3（期限切れ）は getUnreadAnnouncements と異なり
 * 含まれる点に注意（hasAnnouncementBeenPublishedAt は expires_at を見ない）。
 * created_at 降順: a1 > a2 > a3 > a5。
 */
const EXPECTED_ALL = [
  {
    id: 'a1',
    title: '新機能のお知らせ',
    body: 'ガチャ演出を刷新しました',
    severity: 'info',
    is_published: true,
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: '2999-01-01T00:00:00.000+00:00',
    created_at: '2020-01-02T00:00:00.000+00:00',
    is_read: false,
    read_at: null,
  },
  {
    id: 'a2',
    title: 'メンテナンスのお知らせ',
    body: '深夜にメンテナンスを行います',
    severity: 'warning',
    is_published: true,
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: null,
    created_at: '2020-01-01T00:00:00.000+00:00',
    is_read: true,
    read_at: '2020-01-05T00:00:00.000+00:00',
  },
  {
    id: 'a3',
    title: '過去のお知らせ',
    body: '終了済みキャンペーン',
    severity: 'info',
    is_published: true,
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: '2020-02-01T00:00:00.000+00:00',
    created_at: '2019-12-31T00:00:00.000+00:00',
    is_read: false,
    read_at: null,
  },
  {
    id: 'a5',
    title: '公開日時なしのお知らせ',
    body: 'published_at は null',
    severity: 'info',
    is_published: true,
    published_at: null,
    expires_at: null,
    created_at: '2019-12-29T00:00:00.000+00:00',
    is_read: false,
    read_at: null,
  },
]

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from().select().eq().order() を await できる thenable builder
// ---------------------------------------------------------------------------

function createThenableBuilder(result: { data: unknown; error: null }) {
  const builder: any = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return builder
}

function createSupabaseClientMock() {
  const from = vi.fn((table: string) => {
    const data = table === 'announcements' ? ANNOUNCEMENT_ROWS : READ_ROWS
    return createThenableBuilder({ data, error: null })
  })
  return { from }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: db.select(fields).from(table).where().orderBy() を await できる
// thenable builder。実 Drizzle と同様に「select で指定された列だけ」を fixture 行から
// 射影して返す（実装が列を選び忘れた場合に形状差としてテストが落ちるようにする。
// 本実装は列キー = DB 列名なので、射影キー = fields のキーで良い）。
// ---------------------------------------------------------------------------

/** select(...).from(table).where(...).orderBy(...) 1呼び出し分の記録 */
interface DrizzleCallRecord {
  table: unknown
  whereCondition?: unknown
  orderByCondition?: unknown
}

function createDrizzleDbMock() {
  // 先行レビュー指摘への対応: 従来はフィールド射影の一致のみを検証しており、
  // where/orderBy に渡る実引数の回帰（例: is_published の絞り込み漏れ、ソート列/
  // 方向の取り違え）を検知できなかった。from() 呼び出しごとに where/orderBy の
  // 実引数を calls に記録し、テスト側で drizzle-orm の式を組み立てて toEqual で
  // 構造比較できるようにする（token-manager-driver-parity.test.ts の
  // updateCalls/where 記録と同じ方針）。
  const calls: DrizzleCallRecord[] = []
  return {
    calls,
    select: vi.fn((fields: Record<string, unknown>) => ({
      from: vi.fn((table: unknown) => {
        const call: DrizzleCallRecord = { table }
        calls.push(call)
        const rows =
          table === announcementsTable
            ? ANNOUNCEMENT_ROWS
            : table === announcementReadsTable
              ? READ_ROWS
              : []
        const projected = rows.map((row) =>
          Object.fromEntries(
            Object.keys(fields).map((key) => [key, (row as Record<string, unknown>)[key]])
          )
        )
        const builder: any = {
          where: vi.fn((condition: unknown) => {
            call.whereCondition = condition
            return builder
          }),
          orderBy: vi.fn((condition: unknown) => {
            call.orderByCondition = condition
            return builder
          }),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(projected).then(onFulfilled, onRejected),
        }
        return builder
      }),
    })),
  }
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('getUnreadAnnouncements: postgrest / pg 経路の形状互換 (#570)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 環境変数は vi.stubEnv で設定し vi.unstubAllEnvs で確実に復元する。
  // process.env への直接 mutation は、テスト失敗時に復元されず同一プロセスで
  // 実行される他テストへ漏れる構造的リスクがあるため使わない
  // （db-flags.test.ts と同じ変数を扱うため特に重要）。
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function runPostgrestPath() {
    // DB_DRIVER 未設定（= 既定の postgrest 経路）を再現
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const result = await getUnreadAnnouncements('viewer-1')
    return { result, client }
  }

  async function runPgPath() {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const db = createDrizzleDbMock()
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
    const result = await getUnreadAnnouncements('viewer-1')
    return { result, db }
  }

  it('同一 fixture で両経路の戻り値が deepEqual になる', async () => {
    const { result: postgrestResult, client } = await runPostgrestPath()
    const { result: pgResult, db } = await runPgPath()

    // 両経路が実際に実行されたこと（フラグ分岐の検証）
    expect(client.from).toHaveBeenCalledWith('announcements')
    expect(client.from).toHaveBeenCalledWith('announcement_reads')
    expect(db.select).toHaveBeenCalledTimes(2)

    // 形状互換の本体: キー・値とも完全一致
    expect(pgResult).toEqual(postgrestResult)
    expect(postgrestResult).toEqual(EXPECTED)
  })

  // 先行レビュー指摘への対応: フィールド射影の一致だけでは、where/orderBy に渡す
  // 実引数の回帰（例: is_published の絞り込み漏れ、ソート列/方向の取り違え）を
  // 検知できない。実装（getUnreadAnnouncementsPg）と同じ式を drizzle-orm の
  // eq/desc で組み立てて toEqual で構造比較する。
  it('pgクエリが announcements への where(is_published=true)・orderBy(created_at desc) を正しい実引数で呼び出す', async () => {
    const { db } = await runPgPath()

    expect(db.calls).toHaveLength(2)
    expect(db.calls[0].table).toBe(announcementsTable)
    expect(db.calls[0].whereCondition).toEqual(eq(announcementsTable.is_published, true))
    expect(db.calls[0].orderByCondition).toEqual(desc(announcementsTable.created_at))

    // announcement_reads 側も twitch_user_id の絞り込み取り違えを検知できるようにする
    expect(db.calls[1].table).toBe(announcementReadsTable)
    expect(db.calls[1].whereCondition).toEqual(eq(announcementReadsTable.twitch_user_id, 'viewer-1'))
  })

  it('日付フィールドは両経路とも文字列（Date オブジェクトではない）で返る', async () => {
    const { result: postgrestResult } = await runPostgrestPath()
    const { result: pgResult } = await runPgPath()

    for (const result of [postgrestResult, pgResult]) {
      expect(result.length).toBeGreaterThan(0)
      for (const announcement of result) {
        // created_at は常に文字列
        expect(typeof announcement.created_at).toBe('string')
        // published_at は文字列または null（Date になっていないこと）
        if (announcement.published_at !== null) {
          expect(typeof announcement.published_at).toBe('string')
        }
        expect(announcement.published_at).not.toBeInstanceOf(Date)
        expect(announcement.created_at).not.toBeInstanceOf(Date)
      }
    }
  })

  it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない（挙動不変の検証）', async () => {
    await runPostgrestPath()
    expect(getDb).not.toHaveBeenCalled()
  })

  it('pg 経路では supabase-js クライアントが一切呼ばれない', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const db = createDrizzleDbMock()
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)

    const result = await getUnreadAnnouncements('viewer-1')

    expect(result).toEqual(EXPECTED)
    expect(client.from).not.toHaveBeenCalled()
  })
})

/**
 * #663 Category A (2026-07-11): getAllAnnouncements（履歴ページ）は
 * isPgReadEnabled() 分岐が漏れていた（姉妹関数 getUnreadAnnouncements は
 * #570 パイロットで既に移行済み）。上と同じ形状互換方針で pg 直結分岐を検証する。
 */
describe('getAllAnnouncements: postgrest / pg 経路の形状互換 (#663 Category A)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function runPostgrestPathAll() {
    vi.stubEnv('DB_DRIVER', undefined)
    const client = createSupabaseClientMock()
    vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
    const result = await getAllAnnouncements('viewer-1')
    return { result, client }
  }

  async function runPgPathAll() {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const db = createDrizzleDbMock()
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
    const result = await getAllAnnouncements('viewer-1')
    return { result, db }
  }

  it('同一 fixture で両経路の戻り値が deepEqual になる（期限切れも含む・is_read/read_at 付き）', async () => {
    const { result: postgrestResult, client } = await runPostgrestPathAll()
    const { result: pgResult, db } = await runPgPathAll()

    expect(client.from).toHaveBeenCalledWith('announcements')
    expect(client.from).toHaveBeenCalledWith('announcement_reads')
    expect(db.select).toHaveBeenCalledTimes(2)

    expect(pgResult).toEqual(postgrestResult)
    expect(postgrestResult).toEqual(EXPECTED_ALL)
  })

  it('pgクエリが announcements への where(is_published=true)・orderBy(created_at desc) を正しい実引数で呼び出す', async () => {
    const { db } = await runPgPathAll()

    expect(db.calls).toHaveLength(2)
    expect(db.calls[0].table).toBe(announcementsTable)
    expect(db.calls[0].whereCondition).toEqual(eq(announcementsTable.is_published, true))
    expect(db.calls[0].orderByCondition).toEqual(desc(announcementsTable.created_at))

    expect(db.calls[1].table).toBe(announcementReadsTable)
    expect(db.calls[1].whereCondition).toEqual(eq(announcementReadsTable.twitch_user_id, 'viewer-1'))
  })

  it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない（挙動不変の検証）', async () => {
    await runPostgrestPathAll()
    expect(getDb).not.toHaveBeenCalled()
  })

  it('pg 経路では supabase-js クライアントが一切呼ばれない', async () => {
    const { result, client } = await (async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const supabaseClient = createSupabaseClientMock()
      vi.mocked(getSupabaseAdmin).mockReturnValue(supabaseClient as any)
      const db = createDrizzleDbMock()
      vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)
      const res = await getAllAnnouncements('viewer-1')
      return { result: res, client: supabaseClient }
    })()

    expect(result).toEqual(EXPECTED_ALL)
    expect(client.from).not.toHaveBeenCalled()
  })

  // postgrest 経路の非対称フォールバック（announcements 失敗→[]、reads 失敗→全件既読扱い）
  // を pg 経路でも再現できているかは、実装の中で最もバグを埋め込みやすい箇所
  // （getUnreadAnnouncementsPg は両フェーズとも一律 [] を返すのに対し、こちらは
  // reads フェーズだけ別のフォールバックを持つ非対称構造のため）。
  it('reads クエリが失敗した場合、pg 経路は全お知らせを既読扱い（read_at: null）で返す', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const db = createDrizzleDbMock()
    // 1回目の select (announcements) は正常応答、2回目の select (reads) は throw する
    // ようラップする。実装は announcements → reads の順で呼ぶことに依存しているため、
    // 呼び出し順の回帰があればこのテストが意味をなさなくなる（下の calls 検証で担保）。
    let callCount = 0
    const originalSelect = db.select
    db.select = vi.fn((fields: Record<string, unknown>) => {
      callCount += 1
      if (callCount === 2) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              then: (onFulfilled: any, onRejected: any) =>
                Promise.reject(new Error('connection lost')).then(onFulfilled, onRejected),
            })),
          })),
        }
      }
      return (originalSelect as any)(fields)
    }) as any
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)

    const result = await getAllAnnouncements('viewer-1')

    expect(callCount).toBe(2)
    expect(result).toEqual(
      EXPECTED_ALL.map((a) => ({ ...a, is_read: true, read_at: null }))
    )
  })

  it('announcements クエリが失敗した場合、pg 経路は空配列を返す', async () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    const db = createDrizzleDbMock()
    db.select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            then: (onFulfilled: any, onRejected: any) =>
              Promise.reject(new Error('connection lost')).then(onFulfilled, onRejected),
          })),
        })),
      })),
    })) as any
    vi.mocked(getDb).mockResolvedValue({ db, sql: {} } as any)

    const result = await getAllAnnouncements('viewer-1')

    expect(result).toEqual([])
  })
})
