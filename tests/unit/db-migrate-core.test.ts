import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseFilenameVersion,
  parseDescriptorHeader,
  computeChecksum,
  countEffectiveStatements,
  buildMigrationDescriptor,
  loadMigrationFiles,
  readMigrationFile,
  findDuplicateVersions,
  isProviderApplicable,
  collectDescriptorErrors,
  diffMigrationState,
  redactConnectionString,
  extractPasswordCandidates,
  redactSecretsFromText,
  HISTORY_SCHEMA_SQL,
  HISTORY_TABLE_SQL,
} from '../../scripts/lib/db-migrate-core.js'

/**
 * scripts/lib/db-migrate-core.js の純粋関数に対する単体テスト（Issue #692）。
 * DB接続は一切行わない。fs I/O を伴う関数（loadMigrationFiles/readMigrationFile）は
 * 一時ディレクトリを都度作成・削除して検証する
 * （scripts/check-migration-order.test.ts と同様の流儀）。
 */

describe('parseFilenameVersion', () => {
  it('旧形式 (NNNNN_name.sql) から version/name を抽出する', () => {
    expect(parseFilenameVersion('00042_add_foo.sql')).toEqual({ version: '00042', name: 'add_foo' })
  })

  it('新形式 (YYYYMMDDHHMMSS_name.sql) から version/name を抽出する', () => {
    expect(parseFilenameVersion('20260713080000_add_index.sql')).toEqual({
      version: '20260713080000',
      name: 'add_index',
    })
  })

  it('不正なファイル名は null を返す', () => {
    expect(parseFilenameVersion('add_foo.sql')).toBeNull()
    expect(parseFilenameVersion('README.md')).toBeNull()
    expect(parseFilenameVersion('00042.sql')).toBeNull() // '_name' 部分が無い
  })
})

describe('parseDescriptorHeader', () => {
  it('宣言が無ければ安全側のデフォルト (transaction: required, providers: 全対象) を返す', () => {
    const result = parseDescriptorHeader('CREATE TABLE foo (id uuid PRIMARY KEY);')
    expect(result).toEqual({ transaction: 'required', providers: null, errors: [] })
  })

  it('transaction/providers 宣言を先頭のヘッダーコメントから抽出する', () => {
    const content = [
      '-- migration-transaction: forbidden',
      '-- migration-providers: supabase,planetscale',
      '',
      'CREATE INDEX CONCURRENTLY foo_idx ON foo (id);',
    ].join('\n')
    const result = parseDescriptorHeader(content)
    expect(result).toEqual({
      transaction: 'forbidden',
      providers: ['supabase', 'planetscale'],
      errors: [],
    })
  })

  it('providers のカンマ区切りの前後の空白を許容する', () => {
    const content = '-- migration-providers: supabase, postgres\nSELECT 1;'
    expect(parseDescriptorHeader(content).providers).toEqual(['supabase', 'postgres'])
  })

  it('不正な transaction 値は安全側のデフォルトへフォールバックしつつ errors に積む', () => {
    const content = '-- migration-transaction: requireddd\nSELECT 1;'
    const result = parseDescriptorHeader(content)
    expect(result.transaction).toBe('required')
    expect(result.errors[0]).toContain('requireddd')
  })

  it('不正な providers 値は errors に積み providers は null (全対象) にフォールバックする', () => {
    const content = '-- migration-providers: mysql\nSELECT 1;'
    const result = parseDescriptorHeader(content)
    expect(result.providers).toBeNull()
    expect(result.errors[0]).toContain('mysql')
  })

  it('ヘッダーブロック外 (本文中) の同名文字列は宣言として扱わない', () => {
    // 先頭がコメントでなくSQL文から始まる場合、途中にたまたま同じ文字列があっても無視する
    const content = [
      'CREATE TABLE foo (id uuid);',
      '-- migration-transaction: forbidden (これは本文中のコメントであり無視される)',
    ].join('\n')
    const result = parseDescriptorHeader(content)
    expect(result.transaction).toBe('required')
    expect(result.errors).toEqual([])
  })

  it('空の migration-providers 宣言は errors に積み providers は null になる', () => {
    const content = '-- migration-providers: \nSELECT 1;'
    const result = parseDescriptorHeader(content)
    expect(result.providers).toBeNull()
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('computeChecksum', () => {
  it('同一内容は同一checksumを返す', () => {
    expect(computeChecksum('SELECT 1;')).toBe(computeChecksum('SELECT 1;'))
  })

  it('内容が1文字でも変われば異なるchecksumを返す', () => {
    expect(computeChecksum('SELECT 1;')).not.toBe(computeChecksum('SELECT 2;'))
  })

  it('SHA-256 の16進文字列 (64文字) を返す', () => {
    expect(computeChecksum('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('countEffectiveStatements', () => {
  it('単純な1文は1を返す', () => {
    expect(countEffectiveStatements('CREATE INDEX CONCURRENTLY foo_idx ON foo (id);')).toBe(1)
  })

  it('セミコロン区切りの複数文を検出する', () => {
    const content = 'CREATE INDEX CONCURRENTLY a_idx ON a (id);\nCREATE INDEX CONCURRENTLY b_idx ON b (id);'
    expect(countEffectiveStatements(content)).toBe(2)
  })

  it('空行・行全体がコメントの行は除外してカウントする', () => {
    const content = [
      '-- migration-transaction: forbidden',
      '',
      '-- これはコメント行',
      'CREATE INDEX CONCURRENTLY foo_idx ON foo (id);',
      '',
    ].join('\n')
    expect(countEffectiveStatements(content)).toBe(1)
  })

  it('末尾セミコロンのみ・空文のみの場合は0を返す', () => {
    expect(countEffectiveStatements(';\n;\n')).toBe(0)
    expect(countEffectiveStatements('-- コメントだけ\n')).toBe(0)
  })
})

describe('buildMigrationDescriptor', () => {
  it('正常なファイルの descriptor を組み立てる', () => {
    const content = '-- migration-transaction: optional\nSELECT 1;'
    const descriptor = buildMigrationDescriptor('00001_init.sql', content)
    expect(descriptor.version).toBe('00001')
    expect(descriptor.name).toBe('init')
    expect(descriptor.transaction).toBe('optional')
    expect(descriptor.providers).toBeNull()
    expect(descriptor.checksum).toBe(computeChecksum(content))
    expect(descriptor.errors).toEqual([])
  })

  it('不正なファイル名は version/name が null になり errors に理由が積まれる', () => {
    const descriptor = buildMigrationDescriptor('not_numbered.sql', 'SELECT 1;')
    expect(descriptor.version).toBeNull()
    expect(descriptor.name).toBeNull()
    expect(descriptor.errors.some((e: string) => e.includes('不正なファイル名'))).toBe(true)
  })

  // Issue #692 Fableレビュー High-1: Docker実機検証で再現された事故。
  // `transaction: forbidden` は sql.unsafe() の1回のsimple queryバッチとして送信されるため、
  // PostgreSQLは複数文を暗黙のトランザクションブロックとして実行してしまい、
  // CREATE INDEX CONCURRENTLY を2本以上含む forbidden ファイルは
  // 「cannot run inside a transaction block」で実行時に失敗する。
  // これを実行前（descriptor組み立て時点）に検知できることを確認する。
  it('forbidden かつ複数文のファイルは errors に検出される', () => {
    const content = [
      '-- migration-transaction: forbidden',
      '',
      'CREATE INDEX CONCURRENTLY a_idx ON a (id);',
      'CREATE INDEX CONCURRENTLY b_idx ON b (id);',
    ].join('\n')
    const descriptor = buildMigrationDescriptor('00001_two_indexes.sql', content)
    expect(descriptor.transaction).toBe('forbidden')
    expect(descriptor.errors.some((e: string) => e.includes('forbidden') && e.includes('SQL文を1つ'))).toBe(
      true
    )
  })

  it('forbidden かつ単一文のファイルは errors が空', () => {
    const content = ['-- migration-transaction: forbidden', '', 'CREATE INDEX CONCURRENTLY a_idx ON a (id);'].join(
      '\n'
    )
    const descriptor = buildMigrationDescriptor('00001_one_index.sql', content)
    expect(descriptor.transaction).toBe('forbidden')
    expect(descriptor.errors).toEqual([])
  })

  it('required/optional（forbiddenでない）は複数文でもエラーにならない', () => {
    const content = 'CREATE TABLE a (id uuid);\nCREATE TABLE b (id uuid);'
    const descriptor = buildMigrationDescriptor('00001_two_tables.sql', content)
    expect(descriptor.transaction).toBe('required')
    expect(descriptor.errors).toEqual([])
  })
})

describe('fs を伴う関数 (loadMigrationFiles / readMigrationFile)', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('ディレクトリ内の .sql ファイルをファイル名昇順で descriptor 化する', () => {
    dir = mkdtempSync(join(tmpdir(), 'db-migrate-core-test-'))
    writeFileSync(join(dir, '00002_second.sql'), 'SELECT 2;')
    writeFileSync(join(dir, '00001_first.sql'), 'SELECT 1;')
    writeFileSync(join(dir, 'not-a-migration.txt'), 'ignored')

    const descriptors = loadMigrationFiles(dir)
    expect(descriptors.map((d: { filename: string }) => d.filename)).toEqual([
      '00001_first.sql',
      '00002_second.sql',
    ])
  })

  it('readMigrationFile はファイル内容全体を返す', () => {
    dir = mkdtempSync(join(tmpdir(), 'db-migrate-core-test-'))
    writeFileSync(join(dir, '00001_first.sql'), 'SELECT 1;')
    expect(readMigrationFile(dir, '00001_first.sql')).toBe('SELECT 1;')
  })
})

describe('findDuplicateVersions', () => {
  it('重複が無ければ空配列', () => {
    const descriptors = [
      buildMigrationDescriptor('00001_a.sql', 'SELECT 1;'),
      buildMigrationDescriptor('00002_b.sql', 'SELECT 1;'),
    ]
    expect(findDuplicateVersions(descriptors)).toEqual([])
  })

  it('同じ version を持つファイルが複数あれば検出する', () => {
    const descriptors = [
      buildMigrationDescriptor('00001_a.sql', 'SELECT 1;'),
      buildMigrationDescriptor('00001_b.sql', 'SELECT 2;'),
    ]
    const dups = findDuplicateVersions(descriptors)
    expect(dups).toEqual([{ version: '00001', filenames: ['00001_a.sql', '00001_b.sql'] }])
  })

  it('不正なファイル名 (version=null) は重複判定の対象外', () => {
    const descriptors = [
      buildMigrationDescriptor('not_numbered_a.sql', 'SELECT 1;'),
      buildMigrationDescriptor('not_numbered_b.sql', 'SELECT 2;'),
    ]
    expect(findDuplicateVersions(descriptors)).toEqual([])
  })
})

describe('isProviderApplicable', () => {
  it('providers が null (宣言省略) なら常に true', () => {
    expect(isProviderApplicable({ providers: null }, 'supabase')).toBe(true)
    expect(isProviderApplicable({ providers: null }, 'planetscale')).toBe(true)
  })

  it('providers に含まれていれば true、含まれていなければ false', () => {
    expect(isProviderApplicable({ providers: ['supabase'] }, 'supabase')).toBe(true)
    expect(isProviderApplicable({ providers: ['supabase'] }, 'planetscale')).toBe(false)
  })
})

describe('collectDescriptorErrors', () => {
  it('errors が無いdescriptorは対象外', () => {
    const descriptors = [buildMigrationDescriptor('00001_a.sql', 'SELECT 1;')]
    expect(collectDescriptorErrors(descriptors)).toEqual([])
  })

  it('errors があるdescriptorのみ集約する', () => {
    const descriptors = [
      buildMigrationDescriptor('00001_a.sql', 'SELECT 1;'),
      buildMigrationDescriptor('not_numbered.sql', 'SELECT 1;'),
    ]
    const errors = collectDescriptorErrors(descriptors)
    expect(errors).toHaveLength(1)
    expect(errors[0].filename).toBe('not_numbered.sql')
  })
})

describe('diffMigrationState', () => {
  it('historyが空なら全て pending になる', () => {
    const descriptors = [
      buildMigrationDescriptor('00001_a.sql', 'SELECT 1;'),
      buildMigrationDescriptor('00002_b.sql', 'SELECT 2;'),
    ]
    const result = diffMigrationState(descriptors, [], 'supabase')
    expect(result.pending.map((d: { version: string | null }) => d.version)).toEqual(['00001', '00002'])
    expect(result.applied).toEqual([])
    expect(result.checksumMismatches).toEqual([])
    expect(result.missingFiles).toEqual([])
  })

  it('history に一致するchecksumがあれば applied に分類される', () => {
    const content = 'SELECT 1;'
    const descriptors = [buildMigrationDescriptor('00001_a.sql', content)]
    const history = [
      {
        version: '00001',
        name: 'a',
        checksum: computeChecksum(content),
        applied_at: '2026-01-01T00:00:00Z',
        applied_by: 'tester',
        execution_id: 'exec-1',
      },
    ]
    const result = diffMigrationState(descriptors, history, 'supabase')
    expect(result.pending).toEqual([])
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0].appliedBy).toBe('tester')
    expect(result.checksumMismatches).toEqual([])
  })

  it('checksumが変わっていれば checksumMismatches に検出される (ファイル改変検知)', () => {
    const descriptors = [buildMigrationDescriptor('00001_a.sql', 'SELECT 2; -- 改変後')]
    const history = [
      {
        version: '00001',
        name: 'a',
        checksum: computeChecksum('SELECT 1; -- 改変前'),
        applied_at: '2026-01-01T00:00:00Z',
        applied_by: 'tester',
        execution_id: 'exec-1',
      },
    ]
    const result = diffMigrationState(descriptors, history, 'supabase')
    expect(result.checksumMismatches).toHaveLength(1)
    expect(result.checksumMismatches[0].version).toBe('00001')
  })

  it('historyにあるがディスク上にファイルが無ければ missingFiles に検出される', () => {
    const history = [
      {
        version: '00099',
        name: 'deleted',
        checksum: 'abc',
        applied_at: '2026-01-01T00:00:00Z',
        applied_by: 'tester',
        execution_id: 'exec-1',
      },
    ]
    const result = diffMigrationState([], history, 'supabase')
    expect(result.missingFiles).toEqual([{ version: '00099', name: 'deleted' }])
  })

  it('provider不一致のmigrationは skippedForProvider に分類され pending には含まれない', () => {
    const content = '-- migration-providers: planetscale\nSELECT 1;'
    const descriptors = [buildMigrationDescriptor('00001_a.sql', content)]
    const result = diffMigrationState(descriptors, [], 'supabase')
    expect(result.pending).toEqual([])
    expect(result.skippedForProvider).toHaveLength(1)
    expect(result.skippedForProvider[0].version).toBe('00001')
  })
})

describe('redactConnectionString', () => {
  it('パスワードを *** にマスクし、host/db名等はそのまま残す', () => {
    const redacted = redactConnectionString('postgres://myuser:secretpass@db.example.com:5432/mydb?sslmode=require')
    expect(redacted).not.toContain('secretpass')
    expect(redacted).toContain('myuser')
    expect(redacted).toContain('db.example.com')
    expect(redacted).toContain('mydb')
    expect(redacted).toContain('***')
  })

  it('未設定の場合は "(not set)" を返す', () => {
    expect(redactConnectionString(undefined)).toBe('(not set)')
    expect(redactConnectionString('')).toBe('(not set)')
  })

  it('パース不能な文字列はcredentialを含まない固定文字列を返す', () => {
    const redacted = redactConnectionString('not a valid url at all :::')
    expect(redacted).not.toContain('not a valid url at all')
  })
})

describe('extractPasswordCandidates / redactSecretsFromText', () => {
  it('接続文字列に含まれるパスワードをエラーメッセージから除去する', () => {
    const url = 'postgres://myuser:secretpass@db.example.com:5432/mydb'
    const errorText = `connection failed: postgres://myuser:secretpass@db.example.com:5432/mydb refused`
    const redacted = redactSecretsFromText(errorText, url)
    expect(redacted).not.toContain('secretpass')
    expect(redacted).toContain('***')
  })

  it('パスワードが無い接続文字列では候補が空になる', () => {
    expect(extractPasswordCandidates('postgres://db.example.com:5432/mydb')).toEqual([])
  })

  it('接続文字列が無い/不正な場合はテキストをそのまま返す', () => {
    const text = 'some error message'
    expect(redactSecretsFromText(text, undefined)).toBe(text)
    expect(redactSecretsFromText(text, 'not a url')).toBe(text)
  })

  it('URLエンコードされたパスワード (デコード後の値) も除去できる', () => {
    const url = 'postgres://myuser:my%40pass@db.example.com:5432/mydb'
    const errorText = 'password was my@pass which failed'
    const redacted = redactSecretsFromText(errorText, url)
    expect(redacted).not.toContain('my@pass')
  })
})

describe('HISTORY_SCHEMA_SQL / HISTORY_TABLE_SQL', () => {
  it('Issue #692 の設計方針通りの schema/table 定義を持つ', () => {
    expect(HISTORY_SCHEMA_SQL).toContain('create schema if not exists twica_meta')
    expect(HISTORY_TABLE_SQL).toContain('twica_meta.schema_migrations')
    expect(HISTORY_TABLE_SQL).toContain('version text primary key')
    expect(HISTORY_TABLE_SQL).toContain('checksum text not null')
    expect(HISTORY_TABLE_SQL).toContain('execution_id uuid not null')
  })
})
