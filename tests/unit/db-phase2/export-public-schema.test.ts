import { describe, expect, it } from 'vitest'

import {
  buildManifest,
  extractPostgresMajorVersion,
  splitDatabaseUrlPassword,
} from '../../../scripts/db-phase2/export-public-schema.mjs'

describe('db Phase 2 export helpers', () => {
  it('manifestには非機密metadataだけを残し、余分な接続情報を取り込まない', () => {
    const input = {
      capturedAt: '2026-09-16T00:00:00.000Z',
      postgresMajorVersion: 17,
      countsByType: { TABLE: 25, FUNCTION: 22 },
      artifactSha256: 'a'.repeat(64),
      restrictRemovedCount: 2,
      excludedCount: 3,
      maxAppliedMigrationVersion: '20260916000000',
      // APIの契約外フィールドを誤って渡してもmanifestへ拡散しないことを固定する。
      databaseUrl: 'postgres://fixture-user:fixture-secret@db.example.invalid/twica',
      host: 'db.example.invalid',
      password: 'fixture-secret',
    }

    const manifest = buildManifest(input)

    expect(manifest).toEqual({
      capturedAt: '2026-09-16T00:00:00.000Z',
      postgresMajorVersion: 17,
      objectCounts: { TABLE: 25, FUNCTION: 22 },
      artifactSha256: 'a'.repeat(64),
      restrictMetacommandsRemoved: 2,
      excludedObjectCount: 3,
      maxAppliedMigrationVersion: '20260916000000',
    })

    const serialized = JSON.stringify(manifest)
    expect(serialized).not.toContain('fixture-secret')
    expect(serialized).not.toContain('db.example.invalid')
    expect(serialized).not.toContain('postgres://')
  })

  it('migration version未取得時はmanifestへnullを明示する', () => {
    const manifest = buildManifest({
      capturedAt: '2026-09-16T00:00:00.000Z',
      postgresMajorVersion: null,
      countsByType: {},
      artifactSha256: 'b'.repeat(64),
      restrictRemovedCount: 0,
      excludedCount: 0,
    })

    expect(manifest.maxAppliedMigrationVersion).toBeNull()
  })

  it('接続URIからpasswordをargv側から除去しPGPASSWORD用にdecodeする', () => {
    const result = splitDatabaseUrlPassword(
      'postgres://fixture-user:p%40ss%2Fword@db.example.invalid:5432/twica?sslmode=require',
    )

    expect(result.password).toBe('p@ss/word')
    expect(result.sanitizedUrl).toBe(
      'postgres://fixture-user@db.example.invalid:5432/twica?sslmode=require',
    )
    expect(result.sanitizedUrl).not.toContain('p%40ss%2Fword')
    expect(result.sanitizedUrl).not.toContain('p@ss/word')
  })

  it('passwordなしの接続URIはnullを返しURIを維持する', () => {
    expect(
      splitDatabaseUrlPassword('postgres://fixture-user@db.example.invalid/twica'),
    ).toEqual({
      sanitizedUrl: 'postgres://fixture-user@db.example.invalid/twica',
      password: null,
    })
  })

  it('pg_dump headerからPostgreSQL major versionだけを抽出する', () => {
    expect(
      extractPostgresMajorVersion(
        '-- PostgreSQL database dump\n-- Dumped from database version 17.6 (Debian 17.6-1)\n',
      ),
    ).toBe(17)
    expect(extractPostgresMajorVersion('-- Dumped from database version 16\n')).toBe(16)
    expect(extractPostgresMajorVersion('-- PostgreSQL database dump\n')).toBeNull()
  })
})
