/**
 * #570 パイロット: getUnreadAnnouncements の postgrest 経路 / pg 経路の形状互換テスト
 *
 * 同一 fixture を両経路のモックに与え、戻り値が deepEqual であることを検証する。
 * pg 経路（Drizzle）は PostgREST 経路と「完全に同じ戻り値形状（snake_case キー、
 * 日付は文字列）」を返すことが Phase 1 の要件（呼び出し側は経路を意識しない）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { getUnreadAnnouncements } from '@/lib/announcements'
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

/** announcements テーブルの行（SELECT 対象列のみ。日付は PostgREST が返す文字列形式） */
const ANNOUNCEMENT_ROWS = [
  {
    // 表示対象: 公開中・期限内・未読
    id: 'a1',
    title: '新機能のお知らせ',
    body: 'ガチャ演出を刷新しました',
    severity: 'info',
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: '2999-01-01T00:00:00.000+00:00',
    created_at: '2020-01-02T00:00:00.000+00:00',
  },
  {
    // 既読のため除外される
    id: 'a2',
    title: 'メンテナンスのお知らせ',
    body: '深夜にメンテナンスを行います',
    severity: 'warning',
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: null,
    created_at: '2020-01-01T00:00:00.000+00:00',
  },
  {
    // 期限切れのため除外される
    id: 'a3',
    title: '過去のお知らせ',
    body: '終了済みキャンペーン',
    severity: 'info',
    published_at: '2020-01-01T00:00:00.000+00:00',
    expires_at: '2020-02-01T00:00:00.000+00:00',
    created_at: '2019-12-31T00:00:00.000+00:00',
  },
  {
    // 公開予定（未来）のため除外される
    id: 'a4',
    title: '未来のお知らせ',
    body: 'まだ見えないはず',
    severity: 'critical',
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
    published_at: null,
    expires_at: null,
    created_at: '2019-12-29T00:00:00.000+00:00',
  },
]

/** announcement_reads テーブルの行（a2 のみ既読） */
const READ_ROWS = [{ announcement_id: 'a2' }]

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
