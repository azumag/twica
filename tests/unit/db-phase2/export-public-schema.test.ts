import { describe, expect, it } from 'vitest'
import {
  extractPostgresMajorVersion,
  buildManifest,
  splitDatabaseUrlPassword,
} from '../../../scripts/db-phase2/export-public-schema.mjs'

/**
 * fetchMaxAppliedMigrationVersion（supabase_migrations.schema_migrations への実クエリ発行）は
 * 意図的に単体テスト対象にしていない。DB接続を必要とするCLI統合部分であり、main() 同様
 * Docker/実Supabase接続での実機検証（docs/planetscale-schema-baseline.md）で別途確認する方針
 * （既存の extractPostgresMajorVersion / buildManifest のテスト方針を踏襲、ファイル冒頭コメント参照）。
 */

/**
 * scripts/db-phase2/export-public-schema.mjs の純粋関数に対する単体テスト（Issue #691 Chunk 1）。
 * DB接続・pg_dumpの実行は一切行わない（child_process.spawnSync を呼ぶ main() はCLI統合部分で
 * あり、Docker実機検証（docs/planetscale-schema-baseline.md）で別途確認済み）。
 */

describe('extractPostgresMajorVersion', () => {
  it('pg_dumpの "-- Dumped from database version X.Y" 行からメジャーバージョンのみ抽出する', () => {
    const text = '-- Dumped from database version 17.10 (Debian 17.10-1.pgdg13+1)\n'
    expect(extractPostgresMajorVersion(text)).toBe(17)
  })

  it('バージョン行が無い場合は null を返す', () => {
    expect(extractPostgresMajorVersion('CREATE TABLE foo (id uuid);')).toBeNull()
  })

  it('メジャーバージョンのみの表記でも抽出できる', () => {
    expect(extractPostgresMajorVersion('-- Dumped from database version 16\n')).toBe(16)
  })
})

describe('buildManifest', () => {
  const baseArgs = {
    capturedAt: '2026-07-19T12:00:00.000Z',
    postgresMajorVersion: 17,
    countsByType: { TABLE: 25, FUNCTION: 28, TRIGGER: 11, INDEX: 53, POLICY: 29 },
    artifactSha256: 'a'.repeat(64),
    restrictRemovedCount: 2,
    excludedCount: 2,
    maxAppliedMigrationVersion: '20260719180100',
  }

  it('要求されたフィールドのみを持つオブジェクトを組み立てる', () => {
    const manifest = buildManifest(baseArgs)
    expect(manifest).toEqual({
      capturedAt: baseArgs.capturedAt,
      postgresMajorVersion: 17,
      objectCounts: baseArgs.countsByType,
      artifactSha256: baseArgs.artifactSha256,
      restrictMetacommandsRemoved: 2,
      excludedObjectCount: 2,
      maxAppliedMigrationVersion: '20260719180100',
    })
  })

  // Fableレビュー M-7（Issue #691本文の要求項目）: supabase_migrations.schema_migrations の
  // 最大versionをmanifestに含める。
  it('maxAppliedMigrationVersionがmanifestに含まれる', () => {
    const manifest = buildManifest(baseArgs)
    expect(manifest.maxAppliedMigrationVersion).toBe('20260719180100')
  })

  // テーブルが存在しない環境（ローカルDocker検証等、Supabase CLIを使っていないPostgreSQL）や
  // クエリ取得に失敗した場合は null になる（fetchMaxAppliedMigrationVersion側の設計、
  // scripts/db-phase2/export-public-schema.mjs 参照）。buildManifestはその null をそのまま
  // 素通しできる必要がある。
  it('maxAppliedMigrationVersionがnull（未取得/該当テーブル無し）でもmanifestは組み立てられる', () => {
    const manifest = buildManifest({ ...baseArgs, maxAppliedMigrationVersion: null })
    expect(manifest.maxAppliedMigrationVersion).toBeNull()
  })

  it('maxAppliedMigrationVersionを省略した場合もnullとして組み立てられる（呼び出し側の抜け漏れに対する防御）', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 意図的に分割代入で除去する
    const { maxAppliedMigrationVersion, ...argsWithoutField } = baseArgs
    const manifest = buildManifest(argsWithoutField)
    expect(manifest.maxAppliedMigrationVersion).toBeNull()
  })

  it('table/function/trigger/index/policy件数が objectCounts に含まれる（Issue #691 受け入れ条件）', () => {
    const manifest = buildManifest(baseArgs)
    expect(manifest.objectCounts.TABLE).toBe(25)
    expect(manifest.objectCounts.FUNCTION).toBe(28)
    expect(manifest.objectCounts.TRIGGER).toBe(11)
    expect(manifest.objectCounts.INDEX).toBe(53)
    expect(manifest.objectCounts.POLICY).toBe(29)
  })

  // Issue #691 本文の必須要件: host名・接続文字列・パスワードを一切含めない。
  // buildManifest はそもそも引数に接続情報を取らない構造だが（呼び出し側が渡せない設計）、
  // 万一将来引数が拡張された場合に備え、出力オブジェクトの全値を機密情報っぽい文字列
  // （URL形式・"password"等）と照合するテストを置いておく。
  it('manifestのどの値にも接続文字列/ホスト名らしき文字列が含まれない', () => {
    const manifest = buildManifest(baseArgs)
    const serialized = JSON.stringify(manifest)
    expect(serialized).not.toMatch(/postgres(ql)?:\/\//)
    expect(serialized).not.toMatch(/password/i)
    expect(serialized).not.toMatch(/@.*:\d+\//) // host:port/db 形式
  })

  it('postgresMajorVersionがnull（抽出失敗）でもmanifestは組み立てられる', () => {
    const manifest = buildManifest({ ...baseArgs, postgresMajorVersion: null })
    expect(manifest.postgresMajorVersion).toBeNull()
  })
})

/**
 * splitDatabaseUrlPassword（N-3、Fableレビュー2回目対応）の単体テスト。
 * 実際にpg_dumpを起動せず、「argvに渡すsanitizedUrlにパスワードが含まれないこと」
 * 「PGPASSWORD経由で渡すべきpasswordが正しく抽出されること」というコマンド構築ロジックを
 * 純粋関数レベルで検証する（DB接続不要。docs/planetscale-schema-baseline.md「進め方」節の
 * 「コマンド構築ロジックの単体テストレベルで確認」に対応）。
 */
describe('splitDatabaseUrlPassword', () => {
  it('パスワードをURIから除去し、除去したパスワードを別途返す', () => {
    const { sanitizedUrl, password } = splitDatabaseUrlPassword(
      'postgres://twica_app:sup3rsecret@db.example.com:5432/postgres'
    )
    expect(password).toBe('sup3rsecret')
    expect(sanitizedUrl).not.toContain('sup3rsecret')
    expect(sanitizedUrl).toBe('postgres://twica_app@db.example.com:5432/postgres')
  })

  it('パーセントエンコードされたパスワードをデコードして返す（PGPASSWORDは非エンコードの生文字列を期待するため）', () => {
    // '@' は URL 中で '%40' としてエンコードされることが多い
    const { sanitizedUrl, password } = splitDatabaseUrlPassword(
      'postgres://twica_app:p%40ss%3Aword@db.example.com:5432/postgres'
    )
    expect(password).toBe('p@ss:word')
    expect(sanitizedUrl).not.toContain('p%40ss')
    expect(sanitizedUrl).not.toContain('p@ss')
  })

  it('クエリパラメータ（sslmode等）はsanitizedUrlにそのまま残る', () => {
    const { sanitizedUrl, password } = splitDatabaseUrlPassword(
      'postgres://twica_app:secret@db.example.com:5432/postgres?sslmode=require'
    )
    expect(password).toBe('secret')
    expect(sanitizedUrl).toBe('postgres://twica_app@db.example.com:5432/postgres?sslmode=require')
  })

  it('パスワードが含まれないURIの場合、passwordはnullでsanitizedUrlは実質変化しない', () => {
    const { sanitizedUrl, password } = splitDatabaseUrlPassword(
      'postgres://twica_app@db.example.com:5432/postgres'
    )
    expect(password).toBeNull()
    expect(sanitizedUrl).toBe('postgres://twica_app@db.example.com:5432/postgres')
  })

  it('URIとしてパースできない文字列を渡すと例外を投げる（呼び出し側で明確なエラーにするため）', () => {
    expect(() => splitDatabaseUrlPassword('not-a-valid-uri')).toThrow()
  })
})
