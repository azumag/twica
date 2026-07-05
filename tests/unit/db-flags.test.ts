import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getDbDriverMode,
  getGachaDbDriver,
  isPgReadEnabled,
  isPgWriteEnabled,
} from '@/lib/db/flags'

// 環境変数は vi.stubEnv で設定し afterEach の vi.unstubAllEnvs で確実に復元する。
// process.env への直接 mutation は、テスト失敗時に復元されず他テストへ漏れる
// 構造的リスクがある（vitest の推奨パターンに従う）。
// vi.stubEnv(name, undefined) は「その変数が未設定」の状態を再現する。
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getDbDriverMode', () => {
  it('未設定なら postgrest（完全従来動作がデフォルト）', () => {
    vi.stubEnv('DB_DRIVER', undefined)
    expect(getDbDriverMode()).toBe('postgrest')
  })

  it('DB_DRIVER=pg-read を返す', () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    expect(getDbDriverMode()).toBe('pg-read')
  })

  it('DB_DRIVER=pg を返す', () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    expect(getDbDriverMode()).toBe('pg')
  })

  it('DB_DRIVER=postgrest を返す', () => {
    vi.stubEnv('DB_DRIVER', 'postgrest')
    expect(getDbDriverMode()).toBe('postgrest')
  })

  it('不正値は postgrest に倒す', () => {
    vi.stubEnv('DB_DRIVER', 'mysql')
    expect(getDbDriverMode()).toBe('postgrest')
  })

  it('空文字は postgrest に倒す', () => {
    vi.stubEnv('DB_DRIVER', '')
    expect(getDbDriverMode()).toBe('postgrest')
  })

  it('前後の空白・改行は無視される（wrangler secret put の混入対策）', () => {
    vi.stubEnv('DB_DRIVER', ' pg\n')
    expect(getDbDriverMode()).toBe('pg')
    vi.stubEnv('DB_DRIVER', '\tpg-read ')
    expect(getDbDriverMode()).toBe('pg-read')
  })

  it('呼び出しのたびに process.env を読む（モジュールキャッシュしない）', () => {
    vi.stubEnv('DB_DRIVER', undefined)
    expect(getDbDriverMode()).toBe('postgrest')
    // OpenNext の populateProcessEnv のように「後から」env が注入されても反映される
    vi.stubEnv('DB_DRIVER', 'pg')
    expect(getDbDriverMode()).toBe('pg')
  })
})

describe('isPgReadEnabled', () => {
  it('未設定なら false', () => {
    vi.stubEnv('DB_DRIVER', undefined)
    expect(isPgReadEnabled()).toBe(false)
  })

  it('postgrest なら false', () => {
    vi.stubEnv('DB_DRIVER', 'postgrest')
    expect(isPgReadEnabled()).toBe(false)
  })

  it('pg-read なら true', () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    expect(isPgReadEnabled()).toBe(true)
  })

  it('pg なら true', () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    expect(isPgReadEnabled()).toBe(true)
  })
})

describe('isPgWriteEnabled', () => {
  it('未設定なら false', () => {
    vi.stubEnv('DB_DRIVER', undefined)
    expect(isPgWriteEnabled()).toBe(false)
  })

  it('pg-read では false（書き込みは PostgREST のまま）', () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    expect(isPgWriteEnabled()).toBe(false)
  })

  it('pg なら true', () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    expect(isPgWriteEnabled()).toBe(true)
  })
})

describe('getGachaDbDriver', () => {
  it('両方未設定なら postgrest', () => {
    vi.stubEnv('DB_DRIVER', undefined)
    vi.stubEnv('GACHA_DB_DRIVER', undefined)
    expect(getGachaDbDriver()).toBe('postgrest')
  })

  it('GACHA_DB_DRIVER 未設定 + DB_DRIVER=pg なら pg（全体フラグに従う）', () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    vi.stubEnv('GACHA_DB_DRIVER', undefined)
    expect(getGachaDbDriver()).toBe('pg')
  })

  it('GACHA_DB_DRIVER 未設定 + DB_DRIVER=pg-read なら postgrest（読み取り専用モードでは書き込みは旧経路）', () => {
    vi.stubEnv('DB_DRIVER', 'pg-read')
    vi.stubEnv('GACHA_DB_DRIVER', undefined)
    expect(getGachaDbDriver()).toBe('postgrest')
  })

  it('GACHA_DB_DRIVER=postgrest は DB_DRIVER=pg より優先される（緊急ロールバック）', () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    vi.stubEnv('GACHA_DB_DRIVER', 'postgrest')
    expect(getGachaDbDriver()).toBe('postgrest')
  })

  it('GACHA_DB_DRIVER=pg は DB_DRIVER 未設定でも優先される（先行切替）', () => {
    vi.stubEnv('DB_DRIVER', undefined)
    vi.stubEnv('GACHA_DB_DRIVER', 'pg')
    expect(getGachaDbDriver()).toBe('pg')
  })

  it('GACHA_DB_DRIVER が不正値なら全体フラグにフォールバックする', () => {
    vi.stubEnv('DB_DRIVER', 'pg')
    vi.stubEnv('GACHA_DB_DRIVER', 'invalid')
    expect(getGachaDbDriver()).toBe('pg')

    vi.stubEnv('DB_DRIVER', undefined)
    expect(getGachaDbDriver()).toBe('postgrest')
  })

  it('GACHA_DB_DRIVER の前後空白・改行は無視される（緊急ロールバック時の混入対策）', () => {
    // インシデント対応中の 'postgrest\n' 混入でロールバックが無効化されないこと
    vi.stubEnv('DB_DRIVER', 'pg')
    vi.stubEnv('GACHA_DB_DRIVER', 'postgrest\n')
    expect(getGachaDbDriver()).toBe('postgrest')
  })
})
