import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Issue #1953: マイコレクションの配信者非表示。
// 実 DDL の挙動は実 PostgreSQL でしか検証できない（ここではローカル/preview DB へ
// 接続しない）。レビューで目視に頼りがちな不変条件を文字列で固定する:
//   - 宣言ヘッダ・lock_timeout（streamers への FK 追加が streamers に lock を取るため）
//   - 主キー・FK・DEFAULT
//   - 権限（RLS は使わず REVOKE/GRANT。前例 20261023000000 / 20261018030000）
//   - ファイル名が既存の最新 migration より後であること（適用順の保証）

const DIR = 'db/planetscale/migrations'
const NAME = '20261028120000_add_user_collection_hidden_streamers.sql'
const migration = readFileSync(join(process.cwd(), DIR, NAME), 'utf8')

/** 実行コード（行コメント・ブロックコメントを除去） */
function code(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
}
const executable = code(migration)

describe('user_collection_hidden_streamers migration (#1953)', () => {
  it('PlanetScale transaction migration として宣言する', () => {
    expect(migration).toMatch(/^-- migration-transaction: required\n-- migration-providers: planetscale\n/)
  })

  it('最初の文で SET LOCAL lock_timeout を設定する（streamers への FK 追加の lock 待ち対策）', () => {
    const statements = executable.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'")
  })

  it('テーブルを twitch_user_id / streamer_id / hidden_at と複合主キーで作る', () => {
    expect(executable).toMatch(/CREATE TABLE public\.user_collection_hidden_streamers \(/)
    expect(executable).toMatch(/twitch_user_id text NOT NULL,/)
    expect(executable).toMatch(
      /streamer_id uuid NOT NULL REFERENCES public\.streamers\(id\) ON DELETE CASCADE,/
    )
    expect(executable).toMatch(/hidden_at timestamptz NOT NULL DEFAULT now\(\),/)
    expect(executable).toMatch(/PRIMARY KEY \(twitch_user_id, streamer_id\)/)
  })

  it('twitch_user_id には users への FK を張らない（announcement_reads と同じ）', () => {
    expect(executable).not.toMatch(/REFERENCES public\.users/)
  })

  it('既存テーブルを変更せず、新規テーブルの作成だけを行う（expand のみ）', () => {
    expect(executable).not.toMatch(/ALTER TABLE/i)
    expect(executable).not.toMatch(/DROP /i)
    expect(executable.match(/CREATE TABLE/g)).toHaveLength(1)
  })

  it('RLS は使わず、anon/authenticated から剥奪して service_role にだけ付与する', () => {
    expect(executable).not.toMatch(/ROW LEVEL SECURITY/i)
    expect(executable).toContain(
      'REVOKE ALL ON TABLE public.user_collection_hidden_streamers FROM PUBLIC, anon, authenticated;'
    )
    expect(executable).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_collection_hidden_streamers TO service_role;'
    )
  })

  it('テーブル/列に COMMENT を付ける', () => {
    expect(executable).toMatch(/COMMENT ON TABLE public\.user_collection_hidden_streamers IS/)
    expect(executable).toMatch(/COMMENT ON COLUMN public\.user_collection_hidden_streamers\.twitch_user_id IS/)
    expect(executable).toMatch(/COMMENT ON COLUMN public\.user_collection_hidden_streamers\.hidden_at IS/)
  })

  it('ファイル名（version）が作成時点の最新 migration（20261023000000）より後', () => {
    // 「常に最新」ではなく固定の下限と比較する（後続 migration が増えても壊れない）。
    // 適用順そのものの検証は scripts/check-migration-order.js（CI）が担う。
    const names = readdirSync(join(process.cwd(), DIR)).filter((f) => f.endsWith('.sql'))
    expect(names).toContain(NAME)
    expect(NAME.slice(0, 14) > '20261023000000').toBe(true)
  })
})
