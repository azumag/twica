import { describe, expect, it } from 'vitest'
import {
  resolveBaseUrl,
  buildCheckUrls,
  formatUrlCheckFailure,
  schemaEntryLabel,
  formatSchemaCheckFailure,
  isSchemaMissingError,
  summarizeResults,
  SMOKE_TEST_PATHS,
  SCHEMA_CHECKS,
  DEFAULT_BASE_URL,
  resolveDatabaseUrl,
} from '../../scripts/smoke-check.js'

describe('resolveDatabaseUrl', () => {
  it('CI 用の PLANETSCALE_DATABASE_URL をローカル用 DATABASE_URL_PLANETSCALE より優先する', () => {
    expect(resolveDatabaseUrl({
      PLANETSCALE_DATABASE_URL: '  postgres://ci-planetscale  ',
      DATABASE_URL_PLANETSCALE: 'postgres://local-planetscale',
    })).toBe('postgres://ci-planetscale')
  })

  it('PLANETSCALE_DATABASE_URL がなければ DATABASE_URL_PLANETSCALE を使う', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL_PLANETSCALE: ' postgres://local-planetscale ' }))
      .toBe('postgres://local-planetscale')
  })

  it('汎用 DATABASE_URL だけは別サービスの誤配線を防ぐため明示的に拒否する', () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://unexpected-service' })).toBeNull()
  })

  it('空白だけの allow-list 値は未設定として扱う', () => {
    expect(resolveDatabaseUrl({
      PLANETSCALE_DATABASE_URL: '   ',
      DATABASE_URL_PLANETSCALE: '',
      DATABASE_URL: 'postgres://unexpected-service',
    })).toBeNull()
  })
})

describe('resolveBaseUrl', () => {
  it('SMOKE_TEST_BASE_URL が設定されていればそれを使う (末尾スラッシュは除去)', () => {
    expect(resolveBaseUrl({ SMOKE_TEST_BASE_URL: 'https://twica-preview.example.workers.dev/' })).toBe(
      'https://twica-preview.example.workers.dev'
    )
  })

  it('SMOKE_TEST_BASE_URL が空文字/未設定ならデフォルトの本番URLを使う', () => {
    expect(resolveBaseUrl({})).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseUrl({ SMOKE_TEST_BASE_URL: '' })).toBe(DEFAULT_BASE_URL)
    expect(resolveBaseUrl({ SMOKE_TEST_BASE_URL: '   ' })).toBe(DEFAULT_BASE_URL)
  })

  it('前後の空白を除去する', () => {
    expect(resolveBaseUrl({ SMOKE_TEST_BASE_URL: '  https://example.com  ' })).toBe('https://example.com')
  })
})

describe('buildCheckUrls', () => {
  it('ベースURLと各パスを結合する', () => {
    expect(buildCheckUrls('https://example.com', ['/', '/plans'])).toEqual([
      'https://example.com/',
      'https://example.com/plans',
    ])
  })

  it('ベースURLの末尾スラッシュを正規化する', () => {
    expect(buildCheckUrls('https://example.com/', ['/plans'])).toEqual(['https://example.com/plans'])
  })

  it('先頭にスラッシュの無いパスも許容する', () => {
    expect(buildCheckUrls('https://example.com', ['plans'])).toEqual(['https://example.com/plans'])
  })

  it('本番のスモークテスト対象パスに / と /plans を含む', () => {
    expect(SMOKE_TEST_PATHS).toContain('/')
    expect(SMOKE_TEST_PATHS).toContain('/plans')
  })
})

describe('formatUrlCheckFailure', () => {
  it('ステータスコード異常の場合はステータスコードを含める', () => {
    expect(formatUrlCheckFailure({ status: 500 })).toContain('500')
  })

  it('ネットワークエラーの場合はエラーメッセージを含める', () => {
    const message = formatUrlCheckFailure({ error: new Error('fetch failed') })
    expect(message).toContain('fetch failed')
  })

  it('Errorインスタンスでない値も文字列化して含める', () => {
    const message = formatUrlCheckFailure({ error: 'boom' })
    expect(message).toContain('boom')
  })
})

describe('schemaEntryLabel', () => {
  it('column があれば table.column 形式', () => {
    expect(schemaEntryLabel({ table: 'cards', column: 'max_issuance_count' })).toBe('cards.max_issuance_count')
  })

  it('column が null ならテーブル名 + (table) 表記', () => {
    expect(schemaEntryLabel({ table: 'gacha_history', column: null })).toBe('gacha_history (table)')
  })
})

describe('formatSchemaCheckFailure', () => {
  it('table/column/エラーコード/メッセージを含む説明文を組み立てる', () => {
    const message = formatSchemaCheckFailure({
      table: 'cards',
      column: 'max_issuance_count',
      error: { code: '42703', message: 'column "max_issuance_count" does not exist' },
    })
    expect(message).toContain('cards.max_issuance_count')
    expect(message).toContain('42703')
    expect(message).toContain('does not exist')
  })
})

describe('isSchemaMissingError', () => {
  it('null/undefined は false', () => {
    expect(isSchemaMissingError(null)).toBe(false)
    expect(isSchemaMissingError(undefined)).toBe(false)
  })

  it('42703 (undefined_column, 読み取りパス) を検知する', () => {
    expect(isSchemaMissingError({ code: '42703', message: 'column does not exist' })).toBe(true)
  })

  it('42P01 (undefined_table) を検知する', () => {
    expect(isSchemaMissingError({ code: '42P01', message: 'relation does not exist' })).toBe(true)
  })

  it('SQLSTATEがなくても標準undefined column文言を検知する', () => {
    expect(isSchemaMissingError({ message: 'undefined column cards.foo' })).toBe(true)
  })

  it('SQLSTATEがなくても標準undefined table文言を検知する', () => {
    expect(isSchemaMissingError({ message: 'undefined table public.foo' })).toBe(true)
  })

  it('退役HTTP API固有のschema cache文言だけでは検知しない', () => {
    expect(isSchemaMissingError({ message: 'not present in schema cache' })).toBe(false)
  })

  it('無関係なDBエラー (例: 権限エラー) は検知しない', () => {
    expect(isSchemaMissingError({ code: '42501', message: 'permission denied for table cards' })).toBe(false)
  })
})

describe('summarizeResults', () => {
  it('全て成功なら ok:true で件数を報告する', () => {
    const result = summarizeResults([
      { ok: true, name: 'a' },
      { ok: true, name: 'b' },
    ])
    expect(result.ok).toBe(true)
    expect(result.message).toContain('OK')
    expect(result.message).toContain('2')
  })

  it('一部失敗があれば ok:false で失敗内容を列挙する', () => {
    const result = summarizeResults([
      { ok: true, name: 'a' },
      { ok: false, name: 'b', detail: 'それは無い' },
    ])
    expect(result.ok).toBe(false)
    expect(result.message).toContain('NG')
    expect(result.message).toContain('b')
    expect(result.message).toContain('それは無い')
  })

  it('detail が無い失敗は「不明なエラー」で埋める', () => {
    const result = summarizeResults([{ ok: false, name: 'x' }])
    expect(result.message).toContain('不明なエラー')
  })
})

describe('SCHEMA_CHECKS', () => {
  it('直近マイグレーション由来の高シグナルな table/column を含む (#525-527と同型の検知)', () => {
    const labels = SCHEMA_CHECKS.map((entry: { table: string; column: string | null }) =>
      schemaEntryLabel(entry)
    )
    expect(labels).toContain('cards.max_issuance_count')
    expect(labels).toContain('streamers.pack_rarity_weights')
    expect(labels).toContain('gacha_history (table)')
  })
})
