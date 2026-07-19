import { describe, expect, it } from 'vitest'
import { extractPostgresMajorVersion, buildManifest } from '../../../scripts/db-phase2/export-public-schema.mjs'

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
    })
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
