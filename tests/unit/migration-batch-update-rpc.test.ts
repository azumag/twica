import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

/**
 * マイグレーションファイルの静的検証
 * 実際のDB接続なしで、SQLの構造的な正しさを検証する
 *
 * RPC関数の権限設定は実行時テストではなく静的検証で担保する理由:
 * - ユニットテスト環境にはSupabaseインスタンスが無い
 * - マイグレーションファイルの構造が正しければ、適用時に正しく設定される
 * - CIでマイグレーションファイルの破損・欠落を検知できる
 */
describe('マイグレーション: 00011_add_batch_update_card_drop_rates', () => {
  const migrationPath = resolve(
    __dirname,
    '../../supabase/migrations/00011_add_batch_update_card_drop_rates.sql'
  )
  let sql: string

  // マイグレーションファイルの読み込み（テスト全体で1回のみ）
  try {
    sql = readFileSync(migrationPath, 'utf-8')
  } catch {
    sql = ''
  }

  it('マイグレーションファイルが存在する', () => {
    expect(sql.length).toBeGreaterThan(0)
  })

  describe('RPC関数の定義', () => {
    it('batch_update_card_drop_rates関数が定義されている', () => {
      expect(sql).toContain('CREATE OR REPLACE FUNCTION batch_update_card_drop_rates')
    })

    it('p_streamer_id (UUID) パラメータを受け取る', () => {
      expect(sql).toMatch(/p_streamer_id\s+UUID/)
    })

    it('p_updates (JSONB) パラメータを受け取る', () => {
      expect(sql).toMatch(/p_updates\s+JSONB/)
    })

    it('戻り値はJSONB型である', () => {
      expect(sql).toMatch(/RETURNS\s+JSONB/)
    })

    it('streamer_idの一致を検証するWHERE句が含まれる', () => {
      // 他のストリーマーのカードを更新できないことを保証するクエリ条件
      expect(sql).toContain('cards.streamer_id = p_streamer_id')
    })

    it('updated_countを返す', () => {
      // 呼び出し元で更新件数を検証できるようにROW_COUNTを返す
      expect(sql).toContain('GET DIAGNOSTICS v_updated_count = ROW_COUNT')
      expect(sql).toContain("'updated_count'")
    })
  })

  describe('セキュリティ: 実行権限の制限', () => {
    it('PUBLIC からの EXECUTE 権限が剥奪されている', () => {
      // デフォルトではpublicロールにEXECUTEが付与されるため、
      // 明示的なREVOKEがなければanon keyから直接呼び出し可能になってしまう
      expect(sql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+batch_update_card_drop_rates.*FROM\s+PUBLIC/i)
    })

    it('service_role にのみ EXECUTE 権限が付与されている', () => {
      // supabaseAdminクライアント（service_role key使用）からのみ呼び出し可能にする
      expect(sql).toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+batch_update_card_drop_rates.*TO\s+service_role/i)
    })

    it('SECURITY DEFINER が使われていない', () => {
      // SECURITY DEFINERは関数作成者の権限で実行されるため、
      // 不要な権限昇格を避けるために使用しない
      // service_roleは既にRLSをバイパスできるため不要
      // コメント行（-- で始まる行）を除外し、SQLステートメント部分のみを検証
      const sqlStatements = sql
        .split('\n')
        .filter(line => !line.trimStart().startsWith('--'))
        .join('\n')
      expect(sqlStatements).not.toContain('SECURITY DEFINER')
    })
  })
})
