import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH =
  'db/planetscale/migrations/20261018010000_chat_outbox_pending_kind_continuation_backfill_completion.sql'
// BigInt リテラル（123n）は tsconfig の target で使えないため文字列で保持する。
const APPLIED_VERSION = '20261017010000'

const migration = readFileSync(resolve(process.cwd(), MIGRATION_PATH), 'utf8')

// コメント行を除いた実行SQL。コメントには適用後に実行する残件0確認クエリ（UPDATE と同じ述語を
// 持つ SELECT）が説明として載っている。コメント込みで述語を検査すると、UPDATE 本体から述語を
// 削ってもコメントだけでテストが通ってしまうため、SQL本体の検査は必ずこの文字列に対して行う。
const codeOnly = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

describe('chat outbox pending_kind continuation backfill completion migration (Issue #1665 Step 4 補完)', () => {
  it('PlanetScale transaction migrationとして宣言する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale/)
  })

  it('適用済み 20261017010000 より後の version で追加する（適用済みファイルは編集できない）', () => {
    // 20261017010000 は preview で適用済みのため内容を変更できない（checksum 不一致で
    // apply / verify が即エラー終了する）。補正は必ず後続 version として追加する。
    const version = basename(MIGRATION_PATH).split('_')[0]
    expect(BigInt(version) > BigInt(APPLIED_VERSION)).toBe(true)
  })

  it('回帰: 残件の pending_kind を continuation に補正する UPDATE を持つ', () => {
    expect(codeOnly).toContain("SET pending_kind = 'continuation'")
    expect(codeOnly).toContain('UPDATE public.chat_notification_outbox')
  })

  it('cursor を untouched に保持する（reset しない）— delivery_cursor の SET/UPDATE を含まない', () => {
    // 補完 migration も pending_kind のみを補正する。cursor を 0 に戻してはならない。
    expect(codeOnly).not.toContain('delivery_cursor = 0')
    expect(codeOnly).not.toContain('delivery_cursor =')
  })

  it('対象限定: delivery_cursor > 0 AND delivery_cursor < expected_draw_count', () => {
    expect(codeOnly).toContain('delivery_cursor > 0')
    expect(codeOnly).toContain('delivery_cursor < expected_draw_count')
  })

  it('対象限定: pending および lease 失効済み processing 行だけ（lease 有効中の processing は触らない）', () => {
    expect(codeOnly).toContain("status = 'pending'")
    expect(codeOnly).toContain("status = 'processing' AND lease_expires_at <= now()")
  })

  it('対象限定: pending_kind = initial の行だけ（既に continuation の行は触らない＝再適用しても結果が変わらない）', () => {
    expect(codeOnly).toContain("pending_kind = 'initial'")
  })

  it('収束: 実行SQLに打ち切り（LIMIT / FETCH FIRST）も手続き的ループも置かない', () => {
    // 20261017010000 は LIMIT 200 で打ち切ったため、対象が201行以上ある環境に残件を残し得た。
    // 同じ runner 制約（1ファイルを1回実行・同じ transaction で履歴登録・登録済み version は
    // 次回 apply の対象外・ファイル変更は再実行ではなく checksum 不一致エラー）のもとでは、
    // 上限を持つ補完 migration は同じ失敗を繰り返す。よって打ち切りが無いことを固定する。
    expect(codeOnly).not.toMatch(/\bLIMIT\b/i)
    expect(codeOnly).not.toMatch(/\bFETCH\s+(FIRST|NEXT)\b/i)
    // `DO $$ ... LOOP ... EXIT WHEN n >= 200 ... END LOOP $$` のようにループ内で打ち切る実装は
    // LIMIT 検査をすり抜けて同じ残件を再導入できるため、手続き的制御構文自体を置かないことも
    // 固定する（単一 UPDATE で全件補正する契約）。
    expect(codeOnly).not.toMatch(/\bDO\s*\$/i)
    expect(codeOnly).not.toMatch(/\bLOOP\b/i)
    //
    // なお、この unit test はSQL文字列の契約のみを検査する。実DBでの収束
    // （例: 残件201行 → apply → 残件0）は実PG17で別途確認しており、CI の
    // planetscale-migration-postgres job が同じ順序でSQLを実行する。
  })

  it('非加法的 dangerously mutation を含まない (UPDATE のみ)', () => {
    expect(codeOnly).not.toMatch(/\bdrop\s+column\b/i)
    expect(codeOnly).not.toMatch(/\btruncate\b/i)
  })
})
