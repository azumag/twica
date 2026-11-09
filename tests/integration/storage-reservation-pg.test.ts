// Real-PostgreSQL contract test for the storage reservation ledger (#1907).
//
// Drives the SQL functions added by
// db/planetscale/migrations/20261023000000_storage_reservation_and_reconcile.sql
// against a database with the PlanetScale baseline + every migration applied.
//
// The tests exercise the same paths the upload routes use:
//   reserve_storage_usage -> upload (omitted) -> commit/release
// and verify that concurrent reservations from two connections cannot exceed
// the per-user or global limits. The suite is skipped without
// STORAGE_TEST_DATABASE_URL (same policy as the other *-pg.test.ts suites).
//
// Local run:
//   STORAGE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
//     npx vitest run tests/integration/storage-reservation-pg.test.ts
//
// The test database is disposable. beforeAll snapshots and clears
// storage_reservations / blob_files / storage_usage so expectations are exact;
// afterAll restores the snapshot. vitest.config.ts disables file parallelism,
// and the CI job invokes this file on its own, so no other suite races it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import postgres from 'postgres'

const url = process.env.STORAGE_TEST_DATABASE_URL

const sql = url
  ? postgres(url, { max: 8, onnotice: () => {} })
  : null

let originalUsage: Array<Record<string, unknown>> = []
let originalBlobFiles: Array<Record<string, unknown>> = []

const PREFIX_A = '1907a001'
const PREFIX_B = '1907a002'
const PREFIX_C = '1907a003'

async function clearStorageTables(seedGlobal = true): Promise<void> {
  await sql!`DELETE FROM storage_reservations`
  await sql!`DELETE FROM blob_files`
  await sql!`DELETE FROM storage_usage`
  if (seedGlobal) {
    await sql!`INSERT INTO storage_usage (user_prefix, bytes_used, blob_count) VALUES ('_global_', 0, 0)`
  }
}

async function globalUsage(): Promise<{ bytes: number; count: number }> {
  const rows = await sql!`
    SELECT bytes_used, blob_count FROM storage_usage WHERE user_prefix = '_global_'
  `
  return {
    bytes: Number(rows[0]?.bytes_used ?? 0),
    count: Number(rows[0]?.blob_count ?? 0),
  }
}

async function reserve(
  prefix: string,
  size: number,
  userLimit: number,
  globalLimit: number,
): Promise<{ reservation_id: string | null; outcome: string }> {
  const rows = await sql!`
    SELECT reservation_id, outcome
    FROM reserve_storage_usage(
      p_user_prefix => ${prefix},
      p_size => ${size},
      p_user_limit => ${userLimit},
      p_global_limit => ${globalLimit}
    )
  `
  return {
    reservation_id: (rows[0]?.reservation_id as string | null) ?? null,
    outcome: String(rows[0]?.outcome),
  }
}

describe.skipIf(!sql)('storage reservation ledger (PostgreSQL, #1907)', () => {
  beforeAll(async () => {
    originalUsage = await sql!`SELECT user_prefix, bytes_used, blob_count FROM storage_usage`
    originalBlobFiles = await sql!`
      SELECT url, user_prefix, file_size, storage_type FROM blob_files
    `
    await clearStorageTables()
  })

  beforeEach(async () => {
    await clearStorageTables()
  })

  afterAll(async () => {
    if (!sql) return
    // 元の _global_ 行も originalUsage に含まれるため、ここでは seed しない。
    await clearStorageTables(false)
    if (originalUsage.length > 0) {
      await sql`
        INSERT INTO storage_usage ${sql(originalUsage, 'user_prefix', 'bytes_used', 'blob_count')}
      `
    }
    if (originalBlobFiles.length > 0) {
      await sql`
        INSERT INTO blob_files ${sql(originalBlobFiles, 'url', 'user_prefix', 'file_size', 'storage_type')}
      `
    }
    await sql.end({ timeout: 5 })
  })

  it('同一ユーザーの並列予約は片方だけ成功し、解放後は再予約できる', async () => {
    const userLimit = 1000
    const globalLimit = 10_000

    const [first, second] = await Promise.all([
      reserve(PREFIX_A, 600, userLimit, globalLimit),
      reserve(PREFIX_A, 600, userLimit, globalLimit),
    ])

    const outcomes = [first.outcome, second.outcome].sort()
    expect(outcomes).toEqual(['reserved', 'user_limit'])

    const reserved = first.outcome === 'reserved' ? first : second
    const rows = await sql!`
      SELECT id, file_size FROM storage_reservations WHERE user_prefix = ${PREFIX_A}
    `
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].file_size)).toBe(600)

    // storage_usage は予約では動かない（確定時にだけ加算される）。
    const usage = await sql!`
      SELECT bytes_used FROM storage_usage WHERE user_prefix = ${PREFIX_A}
    `
    expect(Number(usage[0]?.bytes_used ?? 0)).toBe(0)

    const released = await sql!`
      SELECT release_storage_reservation(${reserved.reservation_id}::uuid) AS released
    `
    expect(released[0].released).toBe(true)

    const retry = await reserve(PREFIX_A, 600, userLimit, globalLimit)
    expect(retry.outcome).toBe('reserved')
  })

  it('並列ユーザーの合計が全体上限を超えない（片方が global_limit）', async () => {
    const global = await globalUsage()
    const globalLimit = global.bytes + 1000

    const [a, b] = await Promise.all([
      reserve(PREFIX_A, 600, 10_000, globalLimit),
      reserve(PREFIX_B, 600, 10_000, globalLimit),
    ])

    expect([a.outcome, b.outcome].sort()).toEqual(['global_limit', 'reserved'])
  })

  it('commit は blob_files と使用量を原子的に更新し、再送は already_committed になる', async () => {
    const reservation = await reserve(PREFIX_A, 400, 10_000, 10_000)
    expect(reservation.outcome).toBe('reserved')

    const commitSql = (reservationId: string) => sql!`
      SELECT commit_storage_reservation(
        p_reservation_id => ${reservationId}::uuid,
        p_url => 'https://test.invalid/1907/commit.png',
        p_storage_type => 'r2',
        p_user_prefix => ${PREFIX_A},
        p_size => 400
      ) AS outcome
    `

    const committed = await commitSql(reservation.reservation_id!)
    expect(committed[0].outcome).toBe('committed')

    const blob = await sql!`
      SELECT user_prefix, file_size, storage_type
      FROM blob_files WHERE url = 'https://test.invalid/1907/commit.png'
    `
    expect(blob).toHaveLength(1)
    expect(blob[0].user_prefix).toBe(PREFIX_A)
    expect(Number(blob[0].file_size)).toBe(400)
    expect(blob[0].storage_type).toBe('r2')

    const userUsage = await sql!`
      SELECT bytes_used, blob_count FROM storage_usage WHERE user_prefix = ${PREFIX_A}
    `
    expect(Number(userUsage[0].bytes_used)).toBe(400)
    expect(Number(userUsage[0].blob_count)).toBe(1)
    expect(await globalUsage()).toEqual({ bytes: 400, count: 1 })

    const reservations = await sql!`SELECT id FROM storage_reservations`
    expect(reservations).toHaveLength(0)

    // commit の応答だけ失われたケースを想定した再送。
    const retried = await commitSql(reservation.reservation_id!)
    expect(retried[0].outcome).toBe('already_committed')

    // 二重加算されていない。
    expect(await globalUsage()).toEqual({ bytes: 400, count: 1 })

    const released = await sql!`
      SELECT release_storage_reservation(${reservation.reservation_id}::uuid) AS released
    `
    expect(released[0].released).toBe(false)
  })

  it('削除経路の update_storage_usage は減算し、0 未満にしない', async () => {
    const reservation = await reserve(PREFIX_A, 200, 1000, 10_000)
    await sql!`
      SELECT commit_storage_reservation(
        p_reservation_id => ${reservation.reservation_id}::uuid,
        p_url => 'https://test.invalid/1907/delete.png',
        p_storage_type => 'r2',
        p_user_prefix => ${PREFIX_A},
        p_size => 200
      )
    `

    await sql!`SELECT update_storage_usage(${PREFIX_A}, -200, -1)`
    let usage = await sql!`
      SELECT bytes_used, blob_count FROM storage_usage WHERE user_prefix = ${PREFIX_A}
    `
    expect(Number(usage[0].bytes_used)).toBe(0)
    expect(Number(usage[0].blob_count)).toBe(0)

    // 二重減算でも負値にしない（00006 以来の GREATEST(0, ...) 契約）。
    await sql!`SELECT update_storage_usage(${PREFIX_A}, -200, -1)`
    usage = await sql!`
      SELECT bytes_used, blob_count FROM storage_usage WHERE user_prefix = ${PREFIX_A}
    `
    expect(Number(usage[0].bytes_used)).toBe(0)
    expect(Number(usage[0].blob_count)).toBe(0)
    expect(await globalUsage()).toEqual({ bytes: 0, count: 0 })
  })

  it('release は冪等で、予約分の容量を即座に戻す', async () => {
    const reservation = await reserve(PREFIX_A, 300, 1000, 10_000)
    expect(reservation.outcome).toBe('reserved')

    const first = await sql!`
      SELECT release_storage_reservation(${reservation.reservation_id}::uuid) AS released
    `
    const second = await sql!`
      SELECT release_storage_reservation(${reservation.reservation_id}::uuid) AS released
    `
    expect(first[0].released).toBe(true)
    expect(second[0].released).toBe(false)

    // 解放後は同じサイズを予約できる。
    const retry = await reserve(PREFIX_A, 900, 1000, 10_000)
    expect(retry.outcome).toBe('reserved')
  })

  it('期限切れ予約は次の reserve で回収され、容量を占有し続けない', async () => {
    const reservation = await reserve(PREFIX_A, 900, 1000, 10_000)
    expect(reservation.outcome).toBe('reserved')

    await sql!`
      UPDATE storage_reservations
      SET expires_at = now() - interval '1 second'
      WHERE id = ${reservation.reservation_id}::uuid
    `

    const retry = await reserve(PREFIX_A, 700, 1000, 10_000)
    expect(retry.outcome).toBe('reserved')

    const rows = await sql!`
      SELECT id FROM storage_reservations WHERE user_prefix = ${PREFIX_A}
    `
    expect(rows).toHaveLength(1)
  })

  it('reconcile は blob_files を正本に差分を修正し、2回目は0件になる', async () => {
    // blob_files を直接 seed し、storage_usage を意図的にずらす。
    await sql!`
      INSERT INTO blob_files (url, user_prefix, file_size, storage_type) VALUES
        ('https://test.invalid/1907/a.png', ${PREFIX_A}, 100, 'r2'),
        ('https://test.invalid/1907/b.png', ${PREFIX_A}, 200, 'r2'),
        ('https://test.invalid/1907/c.png', ${PREFIX_C}, 50, 'r2')
    `
    await sql!`
      INSERT INTO storage_usage (user_prefix, bytes_used, blob_count) VALUES
        (${PREFIX_A}, 999, 9),
        (${PREFIX_B}, 500, 2)
      ON CONFLICT (user_prefix) DO UPDATE SET
        bytes_used = EXCLUDED.bytes_used,
        blob_count = EXCLUDED.blob_count
    `
    await sql!`
      UPDATE storage_usage SET bytes_used = 1, blob_count = 1 WHERE user_prefix = '_global_'
    `

    const diffs = await sql!`SELECT * FROM reconcile_storage_usage()`
    const byPrefix = new Map(diffs.map((row) => [String(row.user_prefix), row]))

    expect(Number(byPrefix.get(PREFIX_A)?.previous_bytes)).toBe(999)
    expect(Number(byPrefix.get(PREFIX_A)?.actual_bytes)).toBe(300)
    expect(Number(byPrefix.get(PREFIX_A)?.previous_count)).toBe(9)
    expect(Number(byPrefix.get(PREFIX_A)?.actual_count)).toBe(2)

    expect(Number(byPrefix.get(PREFIX_B)?.previous_bytes)).toBe(500)
    expect(Number(byPrefix.get(PREFIX_B)?.actual_bytes)).toBe(0)
    expect(Number(byPrefix.get(PREFIX_B)?.previous_count)).toBe(2)
    expect(Number(byPrefix.get(PREFIX_B)?.actual_count)).toBe(0)

    expect(Number(byPrefix.get(PREFIX_C)?.previous_bytes)).toBe(0)
    expect(Number(byPrefix.get(PREFIX_C)?.actual_bytes)).toBe(50)

    expect(Number(byPrefix.get('_global_')?.previous_bytes)).toBe(1)
    expect(Number(byPrefix.get('_global_')?.actual_bytes)).toBe(350)

    const after = await sql!`
      SELECT user_prefix, bytes_used, blob_count FROM storage_usage ORDER BY user_prefix
    `
    const usage = new Map(after.map((row) => [row.user_prefix, row]))
    expect(Number(usage.get(PREFIX_A)!.bytes_used)).toBe(300)
    expect(Number(usage.get(PREFIX_A)!.blob_count)).toBe(2)
    expect(Number(usage.get(PREFIX_B)!.bytes_used)).toBe(0)
    expect(Number(usage.get(PREFIX_B)!.blob_count)).toBe(0)
    expect(Number(usage.get(PREFIX_C)!.bytes_used)).toBe(50)
    expect(Number(usage.get('_global_')!.bytes_used)).toBe(350)
    expect(Number(usage.get('_global_')!.blob_count)).toBe(3)

    const secondRun = await sql!`SELECT * FROM reconcile_storage_usage()`
    expect(secondRun).toHaveLength(0)
  })

  it('予約中のバイトは reconcile の対象外で、予約行も保持される', async () => {
    const reservation = await reserve(PREFIX_A, 500, 10_000, 10_000)
    expect(reservation.outcome).toBe('reserved')

    const diffs = await sql!`SELECT * FROM reconcile_storage_usage()`
    expect(diffs).toHaveLength(0)

    const rows = await sql!`
      SELECT id FROM storage_reservations WHERE user_prefix = ${PREFIX_A}
    `
    expect(rows).toHaveLength(1)
    expect(await globalUsage()).toEqual({ bytes: 0, count: 0 })
  })

  it('commit が予約と一致しない場合は台帳を更新せず例外にする', async () => {
    const reservation = await reserve(PREFIX_A, 100, 1000, 10_000)

    await expect(
      sql!`
        SELECT commit_storage_reservation(
          p_reservation_id => ${reservation.reservation_id}::uuid,
          p_url => 'https://test.invalid/1907/mismatch.png',
          p_storage_type => 'r2',
          p_user_prefix => ${PREFIX_A},
          p_size => 999
        )
      `,
    ).rejects.toThrow()

    const blob = await sql!`
      SELECT url FROM blob_files WHERE url = 'https://test.invalid/1907/mismatch.png'
    `
    expect(blob).toHaveLength(0)
    expect(await globalUsage()).toEqual({ bytes: 0, count: 0 })
  })
})
