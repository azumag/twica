import { describe, expect, it } from 'vitest'
import { ALLOWLIST, findAllowlistEntry } from '../../../scripts/db-cutover/cutover-allowlist.mjs'

/**
 * Issue #697 Chunk 3: cutover-allowlist.mjs（レイヤー横断allowlist）のテスト。
 * findAllowlistEntryはDB接続を持たない純粋関数のため、fixtureの条件をそのまま渡してテストできる。
 */

describe('ALLOWLIST', () => {
  it('初期内容は3件（#625のbattles/battle_stats不存在 + preview rehearsal followupのhypopg拡張 + CHECK制約deparse差）', () => {
    expect(ALLOWLIST).toHaveLength(3)
  })

  it('全エントリがreason/referenceを空でなく持つ（無視理由を必ずreportできるようにするため）', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(0)
      expect(entry.reference.length).toBeGreaterThan(0)
    }
  })
})

describe('findAllowlistEntry', () => {
  it('data layerのbattlesテーブルに一致する', () => {
    const entry = findAllowlistEntry({ layer: 'data', table: 'battles' })
    expect(entry).not.toBeNull()
    expect(entry?.code).toBe('BATTLE_FEATURE_TABLES_ABSENT_IN_PROD')
  })

  it('data layerのbattle_statsテーブルに一致する', () => {
    const entry = findAllowlistEntry({ layer: 'data', table: 'battle_stats' })
    expect(entry).not.toBeNull()
  })

  it('invariants layerのbattle-stats-consistency invariantIdに一致する', () => {
    const entry = findAllowlistEntry({ layer: 'invariants', invariantId: 'battle-stats-consistency' })
    expect(entry).not.toBeNull()
    expect(entry?.code).toBe('BATTLE_FEATURE_TABLES_ABSENT_IN_PROD')
  })

  it('未登録のテーブル名には一致しない（null）', () => {
    expect(findAllowlistEntry({ layer: 'data', table: 'cards' })).toBeNull()
  })

  it('未登録のinvariantIdには一致しない（null）', () => {
    expect(findAllowlistEntry({ layer: 'invariants', invariantId: 'orphan-foreign-keys' })).toBeNull()
  })

  it('layerが一致しなければtable/invariantIdが同名でも一致しない', () => {
    // battlesはdata layer用エントリのみなので、invariants layerでの照合には一致しない
    expect(findAllowlistEntry({ layer: 'invariants', invariantId: 'battles' })).toBeNull()
  })
})

/**
 * Issue #697 preview rehearsal followup（2026-07-22）: schema layerからの2つの新しい
 * 照会経路（extension用・object用）のテスト。既存のdata/invariants用テストと同じ
 * 「fixtureの条件をそのまま渡す」スタイルを踏襲する。
 *
 * Fable独立レビュー m-1対応（2026-07-22）: extension用の照会は`extname`単独ではなく
 * `extname::schema`の完全一致キー（`key`パラメータ）へ変更された。以前は
 * `{ extname: 'hypopg' }`だけで一致していたが、これだと`hypopg::public`のような
 * PlanetScale管理外の経路まで許容してしまうため、schema込みの完全一致を要求するよう
 * 厳格化されている。
 */
describe('findAllowlistEntry: schema layer（extension、preview rehearsal followup + Fable独立レビュー m-1対応）', () => {
  it('target限定のhypopg::pscale_extensions（完全一致キー）に一致する', () => {
    const entry = findAllowlistEntry({ layer: 'schema', kind: 'extension', key: 'hypopg::pscale_extensions' })
    expect(entry).not.toBeNull()
    expect(entry?.code).toBe('HYPOPG_EXTENSION_PLANETSCALE_MANAGED')
  })

  it('m-1対応の回帰確認: 同名拡張でもschemaが異なれば一致しない（hypopg::public等、PlanetScale管理外の経路は非該当=fail維持）', () => {
    expect(findAllowlistEntry({ layer: 'schema', kind: 'extension', key: 'hypopg::public' })).toBeNull()
    expect(findAllowlistEntry({ layer: 'schema', kind: 'extension', key: 'hypopg::extensions' })).toBeNull()
  })

  it('未登録の拡張機能名には一致しない（null）', () => {
    expect(findAllowlistEntry({ layer: 'schema', kind: 'extension', key: 'pg_trgm::extensions' })).toBeNull()
  })

  it('kindが一致しなければ同名キーでも一致しない（extension用エントリはkind:objectの照会にはヒットしない）', () => {
    // 'hypopg::pscale_extensions' という文字列がobject識別子として仮に照会されても、
    // extension用エントリ（kind:'extension'）とobject用の照会（kind:'object'）は
    // 名前空間を共有しないことを確認する。
    expect(findAllowlistEntry({ layer: 'schema', kind: 'object', key: 'hypopg::pscale_extensions' })).toBeNull()
  })
})

describe('findAllowlistEntry: schema layer（object、preview rehearsal followup）', () => {
  it('TABLE::public::cards に一致する', () => {
    const entry = findAllowlistEntry({ layer: 'schema', kind: 'object', key: 'TABLE::public::cards' })
    expect(entry).not.toBeNull()
    expect(entry?.code).toBe('CHECK_CONSTRAINT_DEPARSE_VERSION_DIFF')
  })

  it('TABLE::public::blob_files に一致する（cardsと同一エントリ、同一reason）', () => {
    const cardsEntry = findAllowlistEntry({ layer: 'schema', kind: 'object', key: 'TABLE::public::cards' })
    const blobFilesEntry = findAllowlistEntry({ layer: 'schema', kind: 'object', key: 'TABLE::public::blob_files' })
    expect(blobFilesEntry).not.toBeNull()
    expect(blobFilesEntry?.code).toBe('CHECK_CONSTRAINT_DEPARSE_VERSION_DIFF')
    expect(blobFilesEntry?.reason).toBe(cardsEntry?.reason)
  })

  it('未登録のオブジェクト識別子には一致しない（null）', () => {
    expect(findAllowlistEntry({ layer: 'schema', kind: 'object', key: 'TABLE::public::streamers' })).toBeNull()
  })

  it('kindが一致しなければ同名でも一致しない（object用エントリはkind:extensionの照会にはヒットしない）', () => {
    expect(findAllowlistEntry({ layer: 'schema', kind: 'extension', key: 'TABLE::public::cards' })).toBeNull()
  })
})

/**
 * Fable独立レビュー m-2対応（2026-07-22）: `matchesSpec`内部ヘルパーが
 * `spec.kind`を実際に判定へ使っているか（プロパティ有無だけで判定していないか）の
 * 回帰確認。ALLOWLIST定義自体が不正な形（`key`を持つのに`kind`を宣言しない等）に
 * なった場合、サイレントに何とでもマッチする/しないという曖昧な挙動ではなく、
 * fail-loudに例外を投げる仕様であることを直接確認する
 * （`findAllowlistEntry`経由ではALLOWLIST配列の正規エントリしか照会できないため、
 * `matchesSpec`が使う内部ロジックの健全性はALLOWLIST自体の形状チェックで代替する）。
 */
describe('ALLOWLIST: 全エントリの形状検証（Fable独立レビュー m-2対応、matchesSpecのkind判定が機能する前提の保全）', () => {
  it('schema layer向けのappliesTo要素（keyを持つもの）は必ずkindを明示している', () => {
    for (const entry of ALLOWLIST) {
      for (const spec of entry.appliesTo) {
        if ('key' in spec) {
          expect(typeof (spec as { kind?: unknown }).kind).toBe('string')
        }
      }
    }
  })

  it('appliesTo要素はtable/invariantId/keyのいずれか1つのみを持つ（互いに排他的、matchesSpecの前提）', () => {
    for (const entry of ALLOWLIST) {
      for (const spec of entry.appliesTo) {
        const props = ['table', 'invariantId', 'key'].filter((p) => p in spec)
        expect(props).toHaveLength(1)
      }
    }
  })
})
