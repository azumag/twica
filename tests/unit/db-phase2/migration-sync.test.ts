import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'

/**
 * db/planetscale/migrations/{20260719180000,20260719180100}_*.sql（db-migrate.js が読む
 * migrationファイルとしてのコピー）の内容が、意図せず書き換えられていないことを検証する
 * （Issue #691 Chunk 1、Fableレビュー M-6 → 2回目レビュー N-1 で設計変更）。
 *
 * ## 設計変更の経緯（N-1、必読）
 *
 * 当初（M-6対応時点）は「正本（db/planetscale/{bootstrap,public-schema}.sql）と
 * migrationコピーのバイト一致」を検証するテストだった。しかしこの設計には構造的な矛盾が
 * あった: `docs/planetscale-schema-baseline.md` の Chunk 2 手順（M-8対応）は
 * 「正本は実Supabaseから採取した最新内容に再生成してよいが、`--bootstrap` で
 * checksum登録済みのmigrationコピー本体は絶対に書き換えてはいけない」と明記している。
 * つまり Chunk 2 で正本を正しく再生成した瞬間に、このテストは意図通りに落ちる。
 * その状態で「テストを緑に戻す」ために最も自然に見える操作（コピー側を正本に合わせて
 * 上書きする）が、まさに禁止されている操作（checksum登録済みファイルの書き換え）と
 * 一致してしまう、という危険な誘導になっていた。
 *
 * ## 新しい設計
 *
 * 「正本とコピーが一致すべきなのは、コピー側がまだ `--bootstrap` でchecksum登録される
 * 前だけ」と割り切り、テストの検証対象を「正本の現在の内容」から「Chunk 1 時点で
 * 固定したsha256ハッシュ（FROZEN_BODY_SHA256）」に変更した。正本ファイル自体は
 * Chunk 2 で自由に再生成してよい（このテストは正本の内容を一切参照しない）。
 *
 * sha256ハッシュのみを埋め込み、3000行超のSQL全文を別ファイル/別fixtureとして
 * 複製しない設計にしたのは、正本・migrationコピーに続く3つ目の全文コピーを
 * リポジトリに増やすと、かえって「どれが正なのか」を分かりにくくするため（YAGNI）。
 * ハッシュ不一致でテストが落ちた場合、実際に何が変わったかは
 * `git diff -- db/planetscale/migrations/<file>` で確認できる（git 自体が
 * 差分の記録を持っているため、別途フルコピーのfixtureを保持する必要性は薄い）。
 *
 * ## 新しいバージョンのbaselineを追加する場合（Chunk 2 以降の運用）
 *
 * 1. 正本（`db/planetscale/{bootstrap,public-schema}.sql`）は自由に上書きしてよい。
 * 2. 新しいタイムスタンプのmigrationファイルを追加する
 *    （例: `db/planetscale/migrations/<YYYYMMDDHHMMSS>_planetscale_public_schema_baseline_v2.sql`）。
 *    既存の `20260719180000`/`20260719180100` は変更しない。
 * 3. 本テストファイルに、新しいmigrationファイル用の
 *    `it(...)` ケースと `FROZEN_BODY_SHA256` エントリを追記する（既存のケースは削除しない）。
 * 4. 詳細な運用手順は `docs/planetscale-schema-baseline.md` の
 *    「baseline再生成時のchecksum衝突運用手順」節を参照。
 */

const PLANETSCALE_DIR = join(__dirname, '../../../db/planetscale')
const MIGRATIONS_DIR = join(PLANETSCALE_DIR, 'migrations')

const MARKER_LINE_RE = /^-- ={10,}$/

/**
 * migrationファイルの内容から、正本を複製した本体部分（マーカー行より後ろ）を取り出す。
 * マーカー行はファイル中に2回（開始線・終了線）現れる設計のため、2回目の出現直後から
 * 本体とみなす（`grep -n "^-- ====" | tail -1` と同じロジックをJSで再現）。
 * マーカーが見つからない場合はテスト自体を失敗させる（凍結チェックが無効化されたまま
 * 気づかれないことを防ぐ）。
 */
function extractCopiedBody(content: string): string {
  const lines = content.split('\n')
  const markerLineIndices = lines.reduce<number[]>((acc, line, idx) => {
    if (MARKER_LINE_RE.test(line)) acc.push(idx)
    return acc
  }, [])
  if (markerLineIndices.length === 0) {
    throw new Error('マーカー行（-- ====...====）が見つかりませんでした。ファイル構造が変わった可能性があります。')
  }
  const lastMarkerIndex = markerLineIndices[markerLineIndices.length - 1]
  return lines.slice(lastMarkerIndex + 1).join('\n')
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Chunk 1（本テスト新設計への移行）時点で固定したハッシュ。正本ファイルが将来
// 再生成されても、このマップの値は更新しない（更新してよいのは、対応する
// migrationファイルが実際にはまだ一度も --bootstrap / apply でDBへ反映されて
// おらず、かつ意図的にChunk 1相当のやり直しをする場合のみ。通常運用では
// 「新しいバージョンのmigrationファイルを追加する」が正しい対応であり、
// 既存エントリの書き換えではない）。
const FROZEN_BODY_SHA256: Record<string, string> = {
  '20260719180000_planetscale_bootstrap.sql':
    '5dd598ecf145edd0ecabe8091c51a1f4739379b9f663a50029584eb8d5c9924f',
  '20260719180100_planetscale_public_schema_baseline.sql':
    'eada074d85444763e5b8162731e56ffa50ad91fcf6ffcbd37930c4abdcc3023d',
}

describe('db/planetscale/migrations/ の内容凍結チェック (N-1、旧M-6から設計変更)', () => {
  it.each(Object.entries(FROZEN_BODY_SHA256))(
    '%s はヘッダーを除いた本体のsha256が固定値と一致する（--bootstrap登録済み内容の意図しない書き換え検知）',
    (filename, expectedHash) => {
      const content = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')
      const body = extractCopiedBody(content)
      expect(sha256(body)).toBe(expectedHash)
    }
  )

  // ヘッダー部分自体には最低限の宣言（migration-transaction/migration-providers）が
  // 含まれていることも確認する（C-1のprovider絞り込みが機能する前提条件）。
  it('両migrationファイルのヘッダーは migration-transaction: required / migration-providers: planetscale を宣言する', () => {
    for (const filename of Object.keys(FROZEN_BODY_SHA256)) {
      const content = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8')
      expect(content).toMatch(/^-- migration-transaction: required$/m)
      expect(content).toMatch(/^-- migration-providers: planetscale$/m)
    }
  })
})
