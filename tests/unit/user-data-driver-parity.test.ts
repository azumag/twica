/**
 * #711: user-data.ts（tos_accepted_at / twitch_has_sub / streamers.id の単純読み取り
 * ヘルパー）の postgrest 経路 / pg 経路の形状互換テスト
 *
 * tests/unit/announcements-driver-parity.test.ts (#570) / token-manager-driver-parity.test.ts
 * (#572) の流儀を踏襲する。各ヘルパーについて「通常行あり」「行なし」「カラム値 null」の
 * 3 fixture を両経路で比較し、加えて各ヘルパーが個別に持つエラー時の設計判断
 * （投げるか、握りつぶすか。src/lib/user-data.ts のコメント参照）を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  getTosAcceptanceRow,
  getTwitchSubRow,
  getStreamerIdByTwitchUserId,
} from '@/lib/user-data'
import { getSupabaseAdmin } from '@/lib/supabase/admin'
import { getDb } from '@/lib/db/client'
import { logger } from '@/lib/logger'
import { streamers as streamersTable, users as usersTable } from '@/lib/db/schema'

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// ---------------------------------------------------------------------------
// postgrest 経路のモック: from(table).select(...).eq(...).maybeSingle() の
// { data, error } を返す thenable。
// ---------------------------------------------------------------------------
function createSupabaseClientMock(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(() => Promise.resolve(result))
  const eqFn = vi.fn(() => ({ maybeSingle }))
  const selectFn = vi.fn(() => ({ eq: eqFn }))
  const from = vi.fn(() => ({ select: selectFn }))
  return { from, selectFn, eqFn, maybeSingle }
}

// ---------------------------------------------------------------------------
// pg 経路のモック: select(fields).from(table).where(cond).limit(n) を await できる
// thenable builder。実装が列を選び忘れた場合に形状差としてテストが落ちるよう、
// select で指定された列だけを fixture 行から射影して返す（announcements-driver-parity
// と同じ方針）。where/limit の実引数も記録し、クエリの取り違えを検知できるようにする。
// ---------------------------------------------------------------------------
interface DrizzleCallRecord {
  table: unknown
  whereCondition?: unknown
  limitArg?: unknown
}

function createDrizzleDbMock(response: { rows?: Array<Record<string, unknown>>; error?: unknown }) {
  const calls: DrizzleCallRecord[] = []
  const select = vi.fn((fields: Record<string, unknown>) => ({
    from: vi.fn((table: unknown) => {
      const call: DrizzleCallRecord = { table }
      calls.push(call)
      const resolve = () =>
        response.error
          ? Promise.reject(response.error)
          : Promise.resolve(
              (response.rows ?? []).map((row) =>
                Object.fromEntries(Object.keys(fields).map((key) => [key, row[key] ?? null]))
              )
            )
      const builder: any = {
        where: vi.fn((condition: unknown) => {
          call.whereCondition = condition
          return builder
        }),
        limit: vi.fn((n: unknown) => {
          call.limitArg = n
          return builder
        }),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
      }
      return builder
    }),
  }))
  return { select, calls }
}

function primePgDb(mock: ReturnType<typeof createDrizzleDbMock>) {
  vi.mocked(getDb).mockResolvedValue({ db: { select: mock.select }, sql: {} } as any)
}

describe('user-data.ts: postgrest / pg 経路の形状互換 (#711)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 環境変数は vi.stubEnv で設定し vi.unstubAllEnvs で確実に復元する
  // （announcements-driver-parity.test.ts と同じ理由: process.env への直接
  // mutation はテスト失敗時に他テストへ漏れる構造的リスクがあるため使わない）
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // -------------------------------------------------------------------------
  // getTosAcceptanceRow: supabase の外形に倣った { row, error } 契約（throw しない）。
  // 「行なし(row=null)」と「行はあるが値が null」を区別できることが呼び出し側
  // （tos/accept route, tos/page.tsx）のクセ再現に必須の要件。
  // エラーの検査/無視は呼び出し元ごとに異なる（route GET は 500 化、page は無視）
  // ため、ヘルパーは error を値で返すだけで判断しない。
  // -------------------------------------------------------------------------
  describe('getTosAcceptanceRow', () => {
    it('行あり・同意済み: 両経路とも { row: { tos_accepted_at: <ISO文字列> }, error: null } を返す', async () => {
      const isoValue = '2026-01-01T00:00:00.000+00:00'

      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: { tos_accepted_at: isoValue }, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getTosAcceptanceRow('user-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [{ tos_accepted_at: isoValue }] })
      primePgDb(pg)
      const pgResult = await getTosAcceptanceRow('user-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(postgrestResult).toEqual({ row: { tos_accepted_at: isoValue }, error: null })
    })

    it('行あり・未同意（tos_accepted_at が null）: 両経路とも row が { tos_accepted_at: null } になる', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: { tos_accepted_at: null }, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getTosAcceptanceRow('user-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [{ tos_accepted_at: null }] })
      primePgDb(pg)
      const pgResult = await getTosAcceptanceRow('user-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(postgrestResult).toEqual({ row: { tos_accepted_at: null }, error: null })
    })

    it('行なし: 両経路とも row が null になる（「行なし」と「値が null」の区別を壊さないことの検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: null, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getTosAcceptanceRow('user-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [] })
      primePgDb(pg)
      const pgResult = await getTosAcceptanceRow('user-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(postgrestResult).toEqual({ row: null, error: null })
      // 行なしは row: { tos_accepted_at: null } ではなく row: null そのものであること
      // （呼び出し側の `row?.tos_accepted_at !== null` が undefined !== null で
      //   true になる既存のクセの再現に必須）
      expect(pgResult.row).toBeNull()
    })

    it('postgrest がエラーを返した場合: throw せず { row: null, error } を返す（error を無視する呼び出し元＝tos/page.tsx では「行なし」扱い＝クセにより hasAccepted=true になる）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const pgrstError = { message: 'boom', code: '42703' }
      const client = createSupabaseClientMock({ data: null, error: pgrstError })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)

      const result = await getTosAcceptanceRow('user-1')

      expect(result.row).toBeNull()
      expect(result.error).toEqual(pgrstError)
      // error を無視する呼び出し元（tos/page.tsx）の判定を再現:
      // row=null → `row?.tos_accepted_at !== null` は true（旧 postgrest 挙動と同一）
      expect(result.row?.tos_accepted_at !== null).toBe(true)
    })

    it('pg 経路が例外を出した場合: throw せず { row: null, error: { message } } に写像する（外形が postgrest エラー時と一致）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ error: new Error('pg boom') })
      primePgDb(pg)

      const result = await getTosAcceptanceRow('user-1')

      expect(result.row).toBeNull()
      expect(result.error).toEqual({ message: 'pg boom' })
      // 呼び出し元が error を検査する場合（route GET）は message を使え、
      // 無視する場合（tos/page.tsx）は row=null → 「行なし」扱い（クセにより true）
      expect(result.row?.tos_accepted_at !== null).toBe(true)
      // pg 例外は errors テーブル→Issue 起票に届く logger.error で記録される
      // （getTwitchSubRow / getStreamerIdByTwitchUserId のテストと対称。
      //  tos/page.tsx 経由の pg 障害の可視性を固定する）
      expect(logger.error).toHaveBeenCalled()
    })

    it('pgクエリが正しい列・where・limit(1)で呼び出される', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [{ tos_accepted_at: null }] })
      primePgDb(pg)
      await getTosAcceptanceRow('user-1')

      expect(pg.calls).toHaveLength(1)
      expect(pg.calls[0].table).toBe(usersTable)
      expect(pg.calls[0].whereCondition).toEqual(eq(usersTable.twitch_user_id, 'user-1'))
      expect(pg.calls[0].limitArg).toBe(1)
    })

    it('postgrest 経路（フラグ未設定）では getDb が一切呼ばれない（挙動不変の検証）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: null, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await getTosAcceptanceRow('user-1')
      expect(getDb).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // getTwitchSubRow: クエリエラー時はレンダリングを止めないよう両経路とも null
  // （pg 経路は withDbRetry の throw を関数内部で catch して吸収する）
  // -------------------------------------------------------------------------
  describe('getTwitchSubRow', () => {
    it('行あり: 両経路とも { twitch_has_sub: true } を返す', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: { twitch_has_sub: true }, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getTwitchSubRow('user-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [{ twitch_has_sub: true }] })
      primePgDb(pg)
      const pgResult = await getTwitchSubRow('user-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(postgrestResult).toEqual({ twitch_has_sub: true })
    })

    it('行あり・twitch_has_sub が null: 両経路とも { twitch_has_sub: null } を返す', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: { twitch_has_sub: null }, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getTwitchSubRow('user-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [{ twitch_has_sub: null }] })
      primePgDb(pg)
      const pgResult = await getTwitchSubRow('user-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(postgrestResult).toEqual({ twitch_has_sub: null })
    })

    it('行なし: 両経路とも null を返す', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: null, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getTwitchSubRow('user-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [] })
      primePgDb(pg)
      const pgResult = await getTwitchSubRow('user-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(postgrestResult).toBeNull()
    })

    it('クエリエラー時: 両経路とも throw せず null を返す（アカウントページのレンダリング非ブロックを維持）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: null, error: { message: 'boom', code: '42703' } })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await expect(getTwitchSubRow('user-1')).resolves.toBeNull()

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ error: new Error('pg boom') })
      primePgDb(pg)
      await expect(getTwitchSubRow('user-1')).resolves.toBeNull()
      // pg 経路はエラーを握りつぶす際に error ログを残すこと（厳格レビュー指摘:
      // logger.error に統一。パイロット群との観測性の非対称を避けるため。
      // src/lib/user-data.ts の catch 節コメント参照）
      expect(logger.error).toHaveBeenCalled()
    })

    it('pgクエリが正しい列・where・limit(1)で呼び出される', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [{ twitch_has_sub: false }] })
      primePgDb(pg)
      await getTwitchSubRow('user-1')

      expect(pg.calls).toHaveLength(1)
      expect(pg.calls[0].table).toBe(usersTable)
      expect(pg.calls[0].whereCondition).toEqual(eq(usersTable.twitch_user_id, 'user-1'))
      expect(pg.calls[0].limitArg).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // getStreamerIdByTwitchUserId: 旧 history/page.tsx は error を無視し（try/catch も
  // 無い）、エラー時は data=null → 「streamer なし」として return null（ページ
  // 非表示、クラッシュしない）だった。pg 例外を伝播させると Server Component が
  // クラッシュして外部挙動が食い違うため、pg 経路の例外も catch して null に写像し、
  // 両ドライバで外部挙動を一致させる。
  // -------------------------------------------------------------------------
  describe('getStreamerIdByTwitchUserId', () => {
    it('行あり: 両経路とも { id } を返す', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: { id: 'streamer-1' }, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getStreamerIdByTwitchUserId('user-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [{ id: 'streamer-1' }] })
      primePgDb(pg)
      const pgResult = await getStreamerIdByTwitchUserId('user-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(postgrestResult).toEqual({ id: 'streamer-1' })
    })

    it('行なし: 両経路とも null を返す（呼び出し元の return null 判定に使われる）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: null, error: null })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      const postgrestResult = await getStreamerIdByTwitchUserId('user-1')

      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [] })
      primePgDb(pg)
      const pgResult = await getStreamerIdByTwitchUserId('user-1')

      expect(pgResult).toEqual(postgrestResult)
      expect(postgrestResult).toBeNull()
    })

    it('postgrest がエラーを返した場合: error を無視して null（旧 history/page.tsx の「streamer なし」扱いの再現）', async () => {
      vi.stubEnv('DB_DRIVER', undefined)
      const client = createSupabaseClientMock({ data: null, error: { message: 'boom', code: '42703' } })
      vi.mocked(getSupabaseAdmin).mockReturnValue(client as any)
      await expect(getStreamerIdByTwitchUserId('user-1')).resolves.toBeNull()
    })

    it('pg 経路が例外を出した場合: throw せず null を返す（Server Component をクラッシュさせず postgrest 経路と同じ外部挙動）', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ error: new Error('pg boom') })
      primePgDb(pg)
      await expect(getStreamerIdByTwitchUserId('user-1')).resolves.toBeNull()
      // 原因調査用の error ログが残ること（外部挙動には影響しない内部ログ。
      // 厳格レビュー指摘によりログレベルは warn ではなく error に統一）
      expect(logger.error).toHaveBeenCalled()
    })

    it('pgクエリが正しい列・where・limit(1)で呼び出される', async () => {
      vi.stubEnv('DB_DRIVER', 'pg-read')
      const pg = createDrizzleDbMock({ rows: [{ id: 'streamer-1' }] })
      primePgDb(pg)
      await getStreamerIdByTwitchUserId('user-1')

      expect(pg.calls).toHaveLength(1)
      expect(pg.calls[0].table).toBe(streamersTable)
      expect(pg.calls[0].whereCondition).toEqual(eq(streamersTable.twitch_user_id, 'user-1'))
      expect(pg.calls[0].limitArg).toBe(1)
    })
  })
})
