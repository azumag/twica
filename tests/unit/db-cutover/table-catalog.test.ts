import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { extractPrimaryKeys, buildTableCatalog, loadTableCatalog } from '../../../scripts/db-cutover/table-catalog.mjs'

/**
 * Issue #697 Chunk 2: table-catalog.mjs のPK抽出・catalog構築テスト。
 *
 * 実際の src/lib/db/schema.ts をパースした結果を、目視確認で固定した期待値
 * （下記 KNOWN_PRIMARY_KEYS）と突き合わせるdrift検知テスト
 * （secret-columns.test.ts の KNOWN_SECRET_COLUMNS 同期テストと同じ流儀）。
 * 将来 schema.ts にテーブルが追加・PK定義が変わった場合、このテストが失敗し
 * 更新漏れを機械的に検知できる。
 */
const KNOWN_PRIMARY_KEYS: Record<string, string[]> = {
  streamers: ['id'],
  cards: ['id'],
  users: ['id'],
  user_cards: ['id'],
  gacha_history: ['id'],
  battles: ['id'],
  battle_stats: ['id'],
  storage_usage: ['user_prefix'],
  blob_files: ['url'],
  streamer_additional_gacha_rewards: ['id'],
  errors: ['id'],
  streamer_storage_bonus: ['id'],
  announcements: ['id'],
  announcement_reads: ['id'],
  support_codes: ['id'],
  user_licenses: ['id'],
  support_inquiries: ['id'],
  support_inquiry_messages: ['id'],
  collection_completions: ['id'],
  channel_point_usage_stats: ['streamer_id', 'user_twitch_id'],
  twitch_bot_accounts: ['id'],
  streamer_chat_sender_settings: ['streamer_id'],
  card_owner_stats: ['streamer_id', 'card_id', 'user_twitch_id'],
  card_stone_balances: ['id'],
  card_stone_transactions: ['id'],
  chat_notification_outbox: ['id'],
}

const schemaPath = join(__dirname, '../../../src/lib/db/schema.ts')
const realSchemaSource = readFileSync(schemaPath, 'utf8')

describe('extractPrimaryKeys（実際のschema.ts、drift検知）', () => {
  it('全26テーブルのPKが KNOWN_PRIMARY_KEYS と完全一致する', () => {
    const extracted = extractPrimaryKeys(realSchemaSource)
    expect(extracted.size).toBe(Object.keys(KNOWN_PRIMARY_KEYS).length)
    for (const [table, expectedPk] of Object.entries(KNOWN_PRIMARY_KEYS)) {
      expect(extracted.get(table), `table '${table}'`).toEqual(expectedPk)
    }
  })
})

describe('extractPrimaryKeys（合成fixture）', () => {
  it('単一列PK（.primaryKey()チェーン）を抽出する', () => {
    const source = `
      import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
      export const widgets = pgTable('widgets', {
        id: uuid('id').primaryKey(),
        name: text('name').notNull(),
      })
    `
    expect(extractPrimaryKeys(source).get('widgets')).toEqual(['id'])
  })

  it('PKが主キー列以外（varchar/text）でも抽出できる', () => {
    const source = `
      import { pgTable, text, varchar } from 'drizzle-orm/pg-core'
      export const widgets = pgTable('widgets', {
        code: varchar('code', { length: 8 }).primaryKey(),
        name: text('name').notNull(),
      })
    `
    expect(extractPrimaryKeys(source).get('widgets')).toEqual(['code'])
  })

  it('複合PK（primaryKey({ columns: [...] })）を宣言順で抽出する', () => {
    const source = `
      import { pgTable, integer, primaryKey, uuid } from 'drizzle-orm/pg-core'
      export const widgetOwners = pgTable(
        'widget_owners',
        {
          widget_id: uuid('widget_id').notNull(),
          owner_id: uuid('owner_id').notNull(),
          count: integer('count').notNull().default(0),
        },
        (table) => [primaryKey({ columns: [table.widget_id, table.owner_id] })]
      )
    `
    expect(extractPrimaryKeys(source).get('widget_owners')).toEqual(['widget_id', 'owner_id'])
  })

  it('3列の複合PKも順序どおり抽出する', () => {
    const source = `
      import { pgTable, integer, primaryKey, uuid } from 'drizzle-orm/pg-core'
      export const triple = pgTable(
        'triple',
        {
          a: uuid('a').notNull(),
          b: uuid('b').notNull(),
          c: uuid('c').notNull(),
          value: integer('value').notNull(),
        },
        (table) => [primaryKey({ columns: [table.a, table.b, table.c] })]
      )
    `
    expect(extractPrimaryKeys(source).get('triple')).toEqual(['a', 'b', 'c'])
  })

  it('複数テーブルを1ファイルにまとめて正しく分離する', () => {
    // 列定義は1行1列というschema.tsの実際のスタイル（verify-db-schema.jsのparseColumnsと
    // 同じ前提）に合わせる。1行に複数列を詰め込むスタイルはこの簡易パーサの対象外
    // （schema.ts自体がそのスタイルを使っていないため実害は無い）。
    const source = `
      import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
      export const a = pgTable('a', {
        id: uuid('id').primaryKey(),
      })
      export const b = pgTable('b', {
        code: text('code').primaryKey(),
      })
    `
    const extracted = extractPrimaryKeys(source)
    expect(extracted.get('a')).toEqual(['id'])
    expect(extracted.get('b')).toEqual(['code'])
  })

  it('PKが1つも見つからないテーブルは例外を投げる（fail-loud）', () => {
    const source = `
      import { pgTable, text, uuid } from 'drizzle-orm/pg-core'
      export const noPk = pgTable('no_pk', {
        id: uuid('id').notNull(),
        name: text('name'),
      })
    `
    expect(() => extractPrimaryKeys(source)).toThrow(/no primary key found/)
  })
})

describe('buildTableCatalog（実際のschema.ts）', () => {
  const catalog = buildTableCatalog(realSchemaSource)

  it('26テーブル全てを含み、テーブル名昇順でソートされている', () => {
    expect(catalog).toHaveLength(26)
    const names = catalog.map((t) => t.tableName)
    expect(names).toEqual([...names].sort())
  })

  it('各テーブルのcolumnsは列名昇順でソートされている', () => {
    for (const table of catalog) {
      const names = table.columns.map((c) => c.name)
      expect(names, `table '${table.tableName}'`).toEqual([...names].sort())
    }
  })

  it('secret列にisSecret=trueが立つ（users.twitch_access_token等）', () => {
    const users = catalog.find((t) => t.tableName === 'users')
    const token = users?.columns.find((c) => c.name === 'twitch_access_token')
    expect(token?.isSecret).toBe(true)
    const username = users?.columns.find((c) => c.name === 'twitch_username')
    expect(username?.isSecret).toBe(false)
  })

  it('support_codes.code_hashもisSecret=trueになる', () => {
    const supportCodes = catalog.find((t) => t.tableName === 'support_codes')
    const hash = supportCodes?.columns.find((c) => c.name === 'code_hash')
    expect(hash?.isSecret).toBe(true)
  })

  it('複合PKテーブルのprimaryKeyColumnsが正しい', () => {
    const cps = catalog.find((t) => t.tableName === 'channel_point_usage_stats')
    expect(cps?.primaryKeyColumns).toEqual(['streamer_id', 'user_twitch_id'])
    const cos = catalog.find((t) => t.tableName === 'card_owner_stats')
    expect(cos?.primaryKeyColumns).toEqual(['streamer_id', 'card_id', 'user_twitch_id'])
  })

  it('timestamp列のdataTypeが正しく分類される', () => {
    const cards = catalog.find((t) => t.tableName === 'cards')
    const createdAt = cards?.columns.find((c) => c.name === 'created_at')
    expect(createdAt?.dataType).toBe('timestamp with time zone')
  })

  it('ARRAY列（text[]）のdataTypeが正しく分類される', () => {
    const users = catalog.find((t) => t.tableName === 'users')
    const scopes = users?.columns.find((c) => c.name === 'twitch_scopes')
    expect(scopes?.dataType).toBe('ARRAY')
  })
})

describe('buildTableCatalog（未対応の型関数が追加された場合の乖離検知、Fableレビュー Major対応）', () => {
  it('parseSchemaFileが認識しない型関数（例: date()）を使う列が追加されると例外を投げる（無言でchecksum対象から脱落させない）', () => {
    // `date(...)` は verify-db-schema.js の TYPE_FN_TO_DATA_TYPE / 列開始正規表現に
    // 含まれていないため、parseSchemaFile はこの列を認識しない。放置すると
    // buildTableCatalog は何のエラーも出さずにこの列をcatalogから除外してしまい、
    // checksum検証の対象が静かに縮小する（このテストが検知したい欠陥そのもの）。
    const source = `
      import { pgTable, text, uuid, date } from 'drizzle-orm/pg-core'
      export const widgets = pgTable('widgets', {
        id: uuid('id').primaryKey(),
        name: text('name').notNull(),
        release_date: date('release_date'),
      })
    `
    expect(() => buildTableCatalog(source)).toThrow(/column-like declarations/)
  })

  it('全列が認識済みの型関数のみで構成されるテーブルは例外を投げない（偽陽性が無いことの確認）', () => {
    const source = `
      import { pgTable, text, uuid, integer } from 'drizzle-orm/pg-core'
      export const widgets = pgTable('widgets', {
        id: uuid('id').primaryKey(),
        name: text('name').notNull(),
        count: integer('count').notNull().default(0),
      })
    `
    expect(() => buildTableCatalog(source)).not.toThrow()
  })
})

describe('loadTableCatalog', () => {
  it('実ファイルを読み込んでbuildTableCatalogと同じ結果を返す', () => {
    expect(loadTableCatalog()).toEqual(buildTableCatalog(realSchemaSource))
  })
})
