import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  SECRET_COLUMN_NAME_PATTERN,
  extractSecretColumnNames,
  KNOWN_SECRET_COLUMNS,
} from '../../../scripts/db-cutover/secret-columns.mjs'

/**
 * Issue #697 Chunk 1 タスク7: secret列の検知漏れ防止テスト。
 *
 * schema.ts から /token|secret|password|hash/i にマッチする列名を抽出し、
 * scripts/db-cutover/secret-columns.mjs の KNOWN_SECRET_COLUMNS と完全一致することを検証する。
 * 将来 schema.ts に新しいsecret風の列（例: xxx_api_key のように既存パターンに追加が必要な
 * ケースを除く、token/secret/password/hashのいずれかを含む列）が追加された場合、この
 * テストが失敗し、KNOWN_SECRET_COLUMNS の更新漏れを機械的に検知できる。
 */
describe('extractSecretColumnNames + KNOWN_SECRET_COLUMNS 同期テスト', () => {
  it('実際の src/lib/db/schema.ts から抽出したsecret列名が KNOWN_SECRET_COLUMNS と完全一致する', () => {
    const schemaPath = join(__dirname, '../../../src/lib/db/schema.ts')
    const source = readFileSync(schemaPath, 'utf8')
    const found = extractSecretColumnNames(source)
    expect(found).toEqual([...KNOWN_SECRET_COLUMNS].sort())
  })

  it('KNOWN_SECRET_COLUMNS 自体に重複が無い', () => {
    expect(new Set(KNOWN_SECRET_COLUMNS).size).toBe(KNOWN_SECRET_COLUMNS.length)
  })
})

describe('extractSecretColumnNames（合成fixture）', () => {
  it('token/secret/password/hashを含む列を "テーブル名.列名" 形式で抽出する', () => {
    const source = `
      import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
      export const widgets = pgTable('widgets', {
        id: uuid('id').primaryKey(),
        name: text('name').notNull(),
        api_token: text('api_token'),
        oauth_secret: text('oauth_secret'),
        login_password: text('login_password'),
        content_hash: text('content_hash'),
      })
    `
    expect(extractSecretColumnNames(source)).toEqual([
      'widgets.api_token',
      'widgets.content_hash',
      'widgets.login_password',
      'widgets.oauth_secret',
    ])
  })

  it('マッチする列が無いテーブルは空配列を返す', () => {
    const source = `
      import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
      export const widgets = pgTable('widgets', {
        id: uuid('id').primaryKey(),
        name: text('name').notNull(),
      })
    `
    expect(extractSecretColumnNames(source)).toEqual([])
  })

  it('複数テーブルにまたがる同名列は table.column 単位で別エントリとして残る（Fableレビュー M-7対応）', () => {
    // 以前の実装は列名のみで重複除去していたため、"secret_key" が2テーブルで共有されている場合
    // 抽出結果が1件に潰れてしまい、将来3つ目のテーブルに同名列が追加されても検知できなかった。
    // table-qualifiedにしたことで、テーブル単位の追加・削除を正確に検知できることを確認する。
    const source = `
      import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
      export const a = pgTable('a', {
        id: uuid('id').primaryKey(),
        secret_key: text('secret_key'),
      })
      export const b = pgTable('b', {
        id: uuid('id').primaryKey(),
        secret_key: text('secret_key'),
        access_token: text('access_token'),
      })
    `
    expect(extractSecretColumnNames(source)).toEqual(['a.secret_key', 'b.access_token', 'b.secret_key'])
  })
})

describe('SECRET_COLUMN_NAME_PATTERN', () => {
  it('Issue #697本文の指定パターンそのまま', () => {
    expect(SECRET_COLUMN_NAME_PATTERN.source).toBe('token|secret|password|hash')
    expect(SECRET_COLUMN_NAME_PATTERN.flags).toContain('i')
  })

  it.each(['twitch_access_token', 'code_hash', 'user_password', 'api_secret', 'TOKEN_VALUE'])(
    '"%s" にマッチする',
    (name) => {
      expect(SECRET_COLUMN_NAME_PATTERN.test(name)).toBe(true)
    }
  )

  it.each(['id', 'name', 'created_at', 'streamer_id'])('"%s" にはマッチしない', (name) => {
    expect(SECRET_COLUMN_NAME_PATTERN.test(name)).toBe(false)
  })
})
