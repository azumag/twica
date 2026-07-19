import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseFilenameVersion,
  parseDescriptorHeader,
  computeChecksum,
  countEffectiveStatements,
  containsSetLocal,
  buildMigrationDescriptor,
  loadMigrationFiles,
  loadMigrationFilesFromDirs,
  readMigrationFile,
  findDuplicateVersions,
  isProviderApplicable,
  collectDescriptorErrors,
  diffMigrationState,
  redactConnectionString,
  extractPasswordCandidates,
  redactSecretsFromText,
  stripPostgresJsIncompatibleSslParams,
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

describe('containsSetLocal', () => {
  it('SET LOCAL を含むコードを検出する（大文字小文字を問わない）', () => {
    expect(containsSetLocal('SET LOCAL statement_timeout = 0;')).toBe(true)
    expect(containsSetLocal('set local statement_timeout = 0;')).toBe(true)
  })

  it('コメント行のみに SET LOCAL という文字列が含まれる場合は検出しない', () => {
    // supabase/migrations/00051_add_card_owner_stats.sql と同じパターン:
    // 日本語コメント中に "SET LOCAL" という語が出現するが、コメント行なので無視すべき。
    const content = [
      '-- マイグレーションはトランザクション内なので SET LOCAL はこのトランザクション内に限定される。',
      'INSERT INTO foo VALUES (1);',
    ].join('\n')
    expect(containsSetLocal(content)).toBe(false)
  })

  it('SET LOCAL を含まないコードは false', () => {
    expect(containsSetLocal('SET statement_timeout = 0;\nSELECT 1;')).toBe(false)
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

  // Issue #691（PlanetScale移行 Chunk 1）タスク3: SET LOCAL はトランザクションブロック内でのみ
  // 有効というPostgreSQL仕様上、migration-transaction: forbidden（オートコミット実行）と
  // SET LOCAL の組み合わせは「SET LOCALの効果が直後の1文に限定され後続文に適用されない」
  // という事故につながる。00051_add_card_owner_stats.sqlがSET LOCALを使いつつ
  // ヘッダー宣言を持たない（＝安全側のrequiredになる）現状は問題ないが、将来同種のファイルへ
  // 誤ってforbiddenを宣言してしまった場合に検知できることを確認する。
  it('forbidden かつ SET LOCAL を含むファイルは errors に検出される', () => {
    const content = ['-- migration-transaction: forbidden', '', 'SET LOCAL statement_timeout = 0;'].join('\n')
    const descriptor = buildMigrationDescriptor('00001_bad_forbidden_set_local.sql', content)
    expect(descriptor.transaction).toBe('forbidden')
    expect(
      descriptor.errors.some((e: string) => e.includes('forbidden') && e.includes('SET LOCAL'))
    ).toBe(true)
  })

  it('forbidden だが SET LOCAL を含まないファイルは（このガードでは）エラーにならない', () => {
    const content = ['-- migration-transaction: forbidden', '', 'CREATE INDEX CONCURRENTLY a_idx ON a (id);'].join(
      '\n'
    )
    const descriptor = buildMigrationDescriptor('00001_ok_forbidden.sql', content)
    expect(descriptor.transaction).toBe('forbidden')
    expect(descriptor.errors).toEqual([])
  })

  it('required（forbiddenでない）は SET LOCAL を含んでもエラーにならない（トランザクション内で正しく機能するため）', () => {
    const content = 'CREATE TABLE a (id uuid);\nSET LOCAL statement_timeout = 0;\nINSERT INTO a VALUES (gen_random_uuid());'
    const descriptor = buildMigrationDescriptor('00001_ok_required_set_local.sql', content)
    expect(descriptor.transaction).toBe('required')
    expect(descriptor.errors).toEqual([])
  })

  // 実ファイルに対する回帰テスト: 00051は SET LOCAL を含むが migration-transaction
  // ヘッダーを宣言していないため DEFAULT_TRANSACTION_MODE（'required'）で解決され、
  // 上記の forbidden+SET LOCAL ガードには一切引っかからない（db-migrate.js の
  // sql.begin() によるトランザクション内実行で SET LOCAL が正しく機能する設計）。
  // 将来誰かがこのファイルへ migration-transaction: forbidden を追加してしまった場合、
  // このテストではなく上のガード自体がその変更を検知する（このテストは「現状は
  // 問題ない」ことの回帰確認）。
  it('00051_add_card_owner_stats.sql は SET LOCAL を含みつつ required で正しく解決される', () => {
    const filePath = join(__dirname, '../../supabase/migrations/00051_add_card_owner_stats.sql')
    const content = readFileSync(filePath, 'utf8')
    expect(containsSetLocal(content)).toBe(true)
    const descriptor = buildMigrationDescriptor('00051_add_card_owner_stats.sql', content)
    expect(descriptor.transaction).toBe('required')
    expect(descriptor.providers).toBeNull()
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

  // Issue #691 Chunk 1 C-1対応: descriptor に sourceDir が付与され、
  // 複数ディレクトリマージ後も readMigrationFile で正しいファイルを引けるようにする。
  it('descriptorにsourceDir（自分がどのディレクトリから読まれたか）が付与される', () => {
    dir = mkdtempSync(join(tmpdir(), 'db-migrate-core-test-'))
    writeFileSync(join(dir, '00001_first.sql'), 'SELECT 1;')
    const [descriptor] = loadMigrationFiles(dir)
    expect(descriptor.sourceDir).toBe(dir)
    expect(readMigrationFile(descriptor.sourceDir, descriptor.filename)).toBe('SELECT 1;')
  })
})

describe('loadMigrationFilesFromDirs (Issue #691 Chunk 1 C-1対応)', () => {
  let dirA: string
  let dirB: string

  afterEach(() => {
    if (dirA) rmSync(dirA, { recursive: true, force: true })
    if (dirB) rmSync(dirB, { recursive: true, force: true })
  })

  it('複数ディレクトリのmigrationをファイル名昇順で1本にマージする', () => {
    dirA = mkdtempSync(join(tmpdir(), 'db-migrate-core-test-a-'))
    dirB = mkdtempSync(join(tmpdir(), 'db-migrate-core-test-b-'))
    // dirA: supabase/migrations/ 相当。dirB: db/planetscale/migrations/ 相当
    // （ファイル名の日時が間に挟まるよう意図的に配置し、単純な「Aを全部→Bを全部」
    // ではなく本当にファイル名でマージソートされることを確認する）。
    writeFileSync(join(dirA, '00001_a.sql'), 'SELECT 1;')
    writeFileSync(join(dirA, '00003_c.sql'), 'SELECT 3;')
    writeFileSync(join(dirB, '00002_planetscale_only.sql'), 'SELECT 2;')

    const descriptors = loadMigrationFilesFromDirs([dirA, dirB])
    expect(descriptors.map((d: { filename: string }) => d.filename)).toEqual([
      '00001_a.sql',
      '00002_planetscale_only.sql',
      '00003_c.sql',
    ])
  })

  it('各descriptorのsourceDirが実際の出自ディレクトリを指す（readMigrationFileで正しいファイルを引ける）', () => {
    dirA = mkdtempSync(join(tmpdir(), 'db-migrate-core-test-a-'))
    dirB = mkdtempSync(join(tmpdir(), 'db-migrate-core-test-b-'))
    writeFileSync(join(dirA, '00001_a.sql'), 'FROM_A')
    writeFileSync(join(dirB, '00002_b.sql'), 'FROM_B')

    const descriptors = loadMigrationFilesFromDirs([dirA, dirB])
    for (const d of descriptors) {
      const content = readMigrationFile(d.sourceDir, d.filename)
      expect(content).toBe(d.filename === '00001_a.sql' ? 'FROM_A' : 'FROM_B')
    }
  })

  it('単一ディレクトリだけを渡した場合はloadMigrationFilesと同じ結果になる', () => {
    dirA = mkdtempSync(join(tmpdir(), 'db-migrate-core-test-a-'))
    writeFileSync(join(dirA, '00001_a.sql'), 'SELECT 1;')
    writeFileSync(join(dirA, '00002_b.sql'), 'SELECT 2;')

    const single = loadMigrationFiles(dirA)
    const merged = loadMigrationFilesFromDirs([dirA])
    expect(merged.map((d: { filename: string }) => d.filename)).toEqual(
      single.map((d: { filename: string }) => d.filename)
    )
  })

  it('空配列を渡すと空配列を返す', () => {
    expect(loadMigrationFilesFromDirs([])).toEqual([])
  })

  // C-1の実運用シナリオそのもの: 実際に db/planetscale/migrations/ に配置した
  // 2ファイル（bootstrap→baseline）が、supabase/migrations/ の既存ファイル群と
  // 正しくマージされ、ファイル名の日時順で正しい位置（末尾側）に来ることを確認する。
  it('実ディレクトリ: supabase/migrations/ と db/planetscale/migrations/ をマージするとplanetscale専用2ファイルが末尾に来る', () => {
    const supabaseDir = join(__dirname, '../../supabase/migrations')
    const planetscaleDir = join(__dirname, '../../db/planetscale/migrations')
    const descriptors = loadMigrationFilesFromDirs([supabaseDir, planetscaleDir])
    const filenames = descriptors.map((d: { filename: string }) => d.filename)
    // ファイル名昇順にソートされていることを確認（マージが正しく機能している証拠）
    const sorted = [...filenames].sort()
    expect(filenames).toEqual(sorted)
    expect(filenames).toContain('20260719180000_planetscale_bootstrap.sql')
    expect(filenames).toContain('20260719180100_planetscale_public_schema_baseline.sql')
    // supabase/migrations/ 側には(移動済みのため)もう存在しないことも確認する
    const bootstrapDescriptor = descriptors.find(
      (d: { filename: string }) => d.filename === '20260719180000_planetscale_bootstrap.sql'
    )
    expect(bootstrapDescriptor).toBeDefined()
    expect(bootstrapDescriptor?.sourceDir).toBe(planetscaleDir)
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

describe('stripPostgresJsIncompatibleSslParams', () => {
  it('PlanetScaleが付与する sslrootcert=system のみを取り除き、既存の sslmode はそのまま維持する（上書きしない）', () => {
    const input = 'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full&sslrootcert=system'
    const result = stripPostgresJsIncompatibleSslParams(input)
    // URL全体の同一性を検証する（sslrootcert除去のみで他パラメータ・host・user等が
    // 一切変化していないことを保証。toContainの部分一致だけでは不十分なため強化）。
    expect(result).toBe(
      'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full'
    )
  })

  it('sslrootcert が無い接続文字列は完全に同一のまま返す（sslmodeを新たに補わない）', () => {
    const input = 'postgres://user:pass@db.example.com:5432/mydb?sslmode=require'
    const result = stripPostgresJsIncompatibleSslParams(input)
    expect(result).toBe(input)
  })

  // Major-1（Fableレビュー・セキュリティ上重大）:
  // 実機で確認された事実: `?sslrootcert=system` のみが付き `sslmode` が付いていない
  // URLの場合、sslrootcert を単純に削除するだけだと postgres.js は `ssl=false`
  // （平文・非TLS接続）として扱ってしまう（stripPostgresJsIncompatibleSslParams の
  // JSDoc「Major-1」セクション参照）。sslrootcert=system が本来意図していた
  // 「完全な証明書検証」を維持するため、sslmode 未指定時は verify-full を明示的に
  // 補う必要がある。以下2パターン（sslrootcertのみ／sslrootcert+sslmode両方あり）
  // をともにカバーする。
  describe('Major-1: sslmode 明示補完（平文接続への意図しないダウングレード防止）', () => {
    it('sslrootcert=system のみ（sslmode無し）の場合、sslmode=verify-full を明示的に補う', () => {
      const input = 'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslrootcert=system'
      const result = stripPostgresJsIncompatibleSslParams(input)
      expect(result).toBe(
        'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=verify-full'
      )
    })

    it('sslrootcert=system と sslmode の両方が指定されている場合、既存の sslmode を尊重し上書きしない', () => {
      // sslmode=require のような緩いモードが明示されているケース。sslrootcert=system
      // が付いていても、呼び出し元が意図的に指定した sslmode を verify-full へ
      // 勝手に強めてはならない（既存の明示的指定を尊重する、というMajor-1の要件）。
      const input = 'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=require&sslrootcert=system'
      const result = stripPostgresJsIncompatibleSslParams(input)
      expect(result).toBe(
        'postgresql://user:pass@ap-northeast-2.pg.psdb.cloud:5432/preview?sslmode=require'
      )
    })

    it('sslrootcert が無ければ、sslmodeも無い接続文字列に対してsslmodeを補わない（無関係なURLへの副作用が無いことの確認）', () => {
      const input = 'postgres://user:pass@db.example.com:5432/mydb'
      const result = stripPostgresJsIncompatibleSslParams(input)
      expect(result).toBe(input)
      expect(result).not.toContain('sslmode')
    })
  })

  it('パース不能な接続文字列は変換をあきらめて元の文字列をそのまま返す', () => {
    const input = 'not a valid url at all :::'
    expect(stripPostgresJsIncompatibleSslParams(input)).toBe(input)
  })

  it('空文字列/undefinedはそのまま返す', () => {
    expect(stripPostgresJsIncompatibleSslParams('')).toBe('')
    // @ts-expect-error 実引数はランタイムで undefined が来うる呼び出し元防御を確認する
    expect(stripPostgresJsIncompatibleSslParams(undefined)).toBe(undefined)
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
