import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  diffNormalizedBlocks,
  compareExtensions,
  runSchemaLayer,
  buildDigestInput,
  extractBootstrapExtensionNames,
  REQUIRED_EXTENSIONS,
  partitionAllowlistedDifferingObjects,
  partitionAllowlistedTargetExtensions,
} from '../../../scripts/db-cutover/layer-schema.mjs'
import { normalizeDump } from '../../../scripts/db-phase2/normalize-schema.mjs'

/**
 * `pgDumpBin` として使う、実行するとfixture内容をそのままstdoutへ出す偽物スクリプトを作る
 * （2回目Fableレビュー Minor-1/Minor-2対応: DB接続もモックライブラリも使わず、実際に
 * child_processが起動されるrunPgDumpPublicSchemaの経路をそのまま通しつつ、出力内容だけを
 * 制御したいための最小限のテストダブル。vi.mock でモジュールを丸ごと差し替えると
 * layer-schema.test.ts内の他テスト（実際のENOENTを検証するもの等）に影響しうるため、
 * このプロジェクトのdb-phase2テスト群がモックを使わない流儀にも合わせ、実プロセスを
 * 起動する素朴な方式にした）。
 * `pgDumpBin` はrunPgDumpPublicSchemaが `[sanitizedUrl, '--schema=public', ...]` という
 * 固定の引数を渡して起動するため、引数の中身に関わらず常に同じfixture内容を返すシェル
 * スクリプトにする。
 */
function writeFakePgDumpScript(stdoutContent: string): { scriptPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'twica-cutover-fake-pgdump-'))
  const fixturePath = join(dir, 'fixture.sql')
  const scriptPath = join(dir, 'fake-pg-dump.sh')
  writeFileSync(fixturePath, stdoutContent, 'utf8')
  writeFileSync(scriptPath, `#!/bin/sh\ncat "${fixturePath}"\n`, 'utf8')
  chmodSync(scriptPath, 0o755)
  return { scriptPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * Issue #697 preview rehearsal followup（2026-07-22）: allowlist配線のテストには
 * 「sourceとtargetで異なるDDLを返すpg_dump」が必要（既存の`writeFakePgDumpScript`は
 * 呼び出し引数に関わらず常に同じ内容を返す）。`runPgDumpPublicSchema`はsanitizedUrl
 * （パスワード除去済みのURL、ホスト名部分は保持される）を第1引数として渡すため、
 * このテストファイルの慣習であるURLホスト名 `source-host`/`target-host`
 * （cli-args.test.ts・本ファイル既存テストと同じ命名）で分岐する固定のシェルスクリプトにする。
 */
function writeFakePgDumpScriptByHost(sourceContent: string, targetContent: string): { scriptPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'twica-cutover-fake-pgdump-asym-'))
  const sourceFixturePath = join(dir, 'source.sql')
  const targetFixturePath = join(dir, 'target.sql')
  const scriptPath = join(dir, 'fake-pg-dump.sh')
  writeFileSync(sourceFixturePath, sourceContent, 'utf8')
  writeFileSync(targetFixturePath, targetContent, 'utf8')
  writeFileSync(
    scriptPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      `  *source-host*) cat "${sourceFixturePath}" ;;`,
      `  *target-host*) cat "${targetFixturePath}" ;;`,
      '  *) echo "writeFakePgDumpScriptByHost: unexpected invocation url: $1" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8'
  )
  chmodSync(scriptPath, 0o755)
  return { scriptPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 複数のTABLEブロックを持つpg_dump出力fixtureを組み立てる（`makeFakeRawDump`の複数テーブル版）。
 */
function makeMultiTableDump(tables: Array<{ name: string; body: string }>): string {
  const header = [
    '--',
    '-- PostgreSQL database dump',
    '--',
    '',
    '',
    '-- Dumped from database version 17.6',
    '-- Dumped by pg_dump version 17.10',
    '',
    'SET statement_timeout = 0;',
    "SELECT pg_catalog.set_config('search_path', '', false);",
    '',
  ]
  const blocks = tables.flatMap(({ name, body }) => ['--', `-- Name: ${name}; Type: TABLE; Schema: public; Owner: -`, '--', '', body, ''])
  return [...header, ...blocks].join('\n')
}

const block = (overrides: Partial<{ raw: string; name: string; type: string; schema: string; category: string }>) => ({
  raw: 'CREATE TABLE public.widgets (id uuid);',
  name: 'widgets',
  type: 'TABLE',
  schema: 'public',
  category: 'bring-as-is',
  ...overrides,
})

/**
 * pg_dumpの実出力に近い最小限のfixtureを組み立てる（オーケストレーターレビュー M-1対応）。
 * バージョンバナー行（`-- Dumped from database version`/`-- Dumped by pg_dump version`）を
 * 差し替え可能にし、preambleの差がdigestに影響しないことを検証するために使う。
 */
function makeFakeRawDump({
  dbVersion,
  pgDumpVersion,
  tableBody = 'CREATE TABLE public.widgets (id uuid NOT NULL, name text);',
}: {
  dbVersion: string
  pgDumpVersion: string
  tableBody?: string
}) {
  return [
    '--',
    '-- PostgreSQL database dump',
    '--',
    '',
    '',
    `-- Dumped from database version ${dbVersion}`,
    `-- Dumped by pg_dump version ${pgDumpVersion}`,
    '',
    'SET statement_timeout = 0;',
    "SELECT pg_catalog.set_config('search_path', '', false);",
    '',
    '--',
    '-- Name: widgets; Type: TABLE; Schema: public; Owner: -',
    '--',
    '',
    tableBody,
    '',
  ].join('\n')
}

describe('buildDigestInput（オーケストレーターレビュー M-1対応: schema digestへのpg_dumpバージョンバナー混入を修正）', () => {
  it('修正前の実装（normalizeDump().output全体をdigest化）ならバージョンバナーの差だけでも出力全体が不一致になっていたことの確認', () => {
    const source = normalizeDump(makeFakeRawDump({ dbVersion: '17.6', pgDumpVersion: '17.10 (Homebrew)' }))
    const target = normalizeDump(makeFakeRawDump({ dbVersion: '16.4', pgDumpVersion: '17.10' }))
    // 修正前の実装はこの `.output` をそのままdigest化していたため、スキーマ実体が同一でも
    // digestが不一致になっていた（このアサーション自体は「バグが実在した」ことの記録）。
    expect(source.output).not.toBe(target.output)
  })

  it('スキーマ実体（テーブル定義）が同一なら、source/targetでバージョンバナーが異なってもdigest入力は完全一致する', () => {
    const source = normalizeDump(makeFakeRawDump({ dbVersion: '17.6', pgDumpVersion: '17.10 (Homebrew)' }))
    const target = normalizeDump(
      makeFakeRawDump({ dbVersion: '16.4 (PlanetScale managed Postgres)', pgDumpVersion: '17.10 (Debian 17.10-1.pgdg13+1)' })
    )
    expect(buildDigestInput(source.blocks)).toBe(buildDigestInput(target.blocks))
    // sha256ハッシュ計算そのもの（実際にreportで使われる形）でも一致することを確認する。
    const sourceDigest = createHash('sha256').update(buildDigestInput(source.blocks), 'utf8').digest('hex')
    const targetDigest = createHash('sha256').update(buildDigestInput(target.blocks), 'utf8').digest('hex')
    expect(sourceDigest).toBe(targetDigest)
  })

  it('スキーマ実体が実際に異なる場合は、バージョンバナーが同一でもdigest入力が異なる（検出能力の回帰確認）', () => {
    const source = normalizeDump(makeFakeRawDump({ dbVersion: '17.6', pgDumpVersion: '17.10' }))
    const target = normalizeDump(
      makeFakeRawDump({ dbVersion: '17.6', pgDumpVersion: '17.10', tableBody: 'CREATE TABLE public.widgets (id uuid NOT NULL, name text, extra_column integer);' })
    )
    expect(buildDigestInput(source.blocks)).not.toBe(buildDigestInput(target.blocks))
  })

  it('bring-as-isブロックの出力順序が異なっても、ソートしてから結合するため入力は一致する', () => {
    const blocksInOrderA = [block({ name: 'aaa' }), block({ name: 'zzz' })]
    const blocksInOrderB = [block({ name: 'zzz' }), block({ name: 'aaa' })]
    expect(buildDigestInput(blocksInOrderA)).toBe(buildDigestInput(blocksInOrderB))
  })

  it('category=exclude のブロックはdigest計算対象から除外される', () => {
    const blocks = [block({ name: 'public', type: 'SCHEMA', category: 'exclude' }), block({ name: 'widgets' })]
    expect(buildDigestInput(blocks)).toBe(buildDigestInput([block({ name: 'widgets' })]))
  })
})

describe('diffNormalizedBlocks', () => {
  it('完全に一致するブロック配列なら差分ゼロ', () => {
    const blocks = [block({})]
    const diff = diffNormalizedBlocks(blocks, blocks)
    expect(diff).toEqual({ onlyInSource: [], onlyInTarget: [], differing: [], identicalCount: 1 })
  })

  it('sourceにしか存在しないオブジェクトを onlyInSource として検出する', () => {
    const sourceBlocks = [block({ name: 'widgets' }), block({ name: 'gadgets' })]
    const targetBlocks = [block({ name: 'widgets' })]
    const diff = diffNormalizedBlocks(sourceBlocks, targetBlocks)
    expect(diff.onlyInSource).toEqual(['TABLE::public::gadgets'])
    expect(diff.onlyInTarget).toEqual([])
  })

  it('targetにしか存在しないオブジェクトを onlyInTarget として検出する', () => {
    const sourceBlocks = [block({ name: 'widgets' })]
    const targetBlocks = [block({ name: 'widgets' }), block({ name: 'new_table' })]
    const diff = diffNormalizedBlocks(sourceBlocks, targetBlocks)
    expect(diff.onlyInTarget).toEqual(['TABLE::public::new_table'])
  })

  it('同名同種だが定義本文が異なるオブジェクトを differing として検出する（列追加/型変更/列削除を含む）', () => {
    const sourceBlocks = [block({ name: 'cards', raw: 'CREATE TABLE public.cards (id uuid, hp integer);' })]
    const targetBlocks = [block({ name: 'cards', raw: 'CREATE TABLE public.cards (id uuid, hp text);' })]
    const diff = diffNormalizedBlocks(sourceBlocks, targetBlocks)
    expect(diff.differing).toEqual(['TABLE::public::cards'])
    expect(diff.identicalCount).toBe(0)
  })

  it('type/schemaが異なれば別オブジェクト扱い（同名でもキーが分かれる）', () => {
    const sourceBlocks = [block({ name: 'cards', type: 'TABLE' })]
    const targetBlocks = [block({ name: 'cards', type: 'INDEX' })]
    const diff = diffNormalizedBlocks(sourceBlocks, targetBlocks)
    expect(diff.onlyInSource).toEqual(['TABLE::public::cards'])
    expect(diff.onlyInTarget).toEqual(['INDEX::public::cards'])
  })

  it('category=exclude のブロックは比較対象から除外される（public schema自身の再作成文など）', () => {
    const sourceBlocks = [block({ name: 'public', type: 'SCHEMA', category: 'exclude' })]
    const targetBlocks: ReturnType<typeof block>[] = []
    const diff = diffNormalizedBlocks(sourceBlocks, targetBlocks)
    expect(diff).toEqual({ onlyInSource: [], onlyInTarget: [], differing: [], identicalCount: 0 })
  })

  it('ROW SECURITY ブロック（RLS enabled）の有無差分も検出できる', () => {
    const sourceBlocks = [
      block({ name: 'cards', type: 'ROW SECURITY', raw: 'ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;' }),
    ]
    const targetBlocks: ReturnType<typeof block>[] = []
    const diff = diffNormalizedBlocks(sourceBlocks, targetBlocks)
    expect(diff.onlyInSource).toEqual(['ROW SECURITY::public::cards'])
  })

  it('結果配列はソート済み（決定的な出力のため）', () => {
    const sourceBlocks = [block({ name: 'zzz' }), block({ name: 'aaa' })]
    const diff = diffNormalizedBlocks(sourceBlocks, [])
    expect(diff.onlyInSource).toEqual(['TABLE::public::aaa', 'TABLE::public::zzz'])
  })

  it('同一キーのブロックが同一側に複数あると例外を投げる（Fableレビュー Minor-9対応、fail-fast）', () => {
    const sourceBlocks = [block({ name: 'dup' }), block({ name: 'dup', raw: 'different body' })]
    expect(() => diffNormalizedBlocks(sourceBlocks, [])).toThrow(/TOCキーが重複/)
  })
})

describe('compareExtensions（Fableレビュー M-2対応: 必須拡張とプラットフォーム拡張の非対称ポリシー）', () => {
  it('REQUIRED_EXTENSIONSはuuid-ossp/pgcryptoの2つ', () => {
    expect(REQUIRED_EXTENSIONS).toEqual(['uuid-ossp', 'pgcrypto'])
  })

  it('完全一致なら差分なし・欠落なし', () => {
    const rows = REQUIRED_EXTENSIONS.map((extname) => ({ extname, schema: 'extensions' }))
    expect(compareExtensions(rows, rows)).toEqual({
      onlyInSource: [],
      onlyInTarget: [],
      onlyInSourceInformational: [],
      missingRequired: [],
    })
  })

  it('必須拡張がtargetに欠落していれば missingRequired に載る', () => {
    const source = [{ extname: 'uuid-ossp', schema: 'extensions' }, { extname: 'pgcrypto', schema: 'extensions' }]
    const target = [{ extname: 'pgcrypto', schema: 'extensions' }]
    const diff = compareExtensions(source, target)
    expect(diff.missingRequired).toEqual(['uuid-ossp'])
    expect(diff.onlyInSource).toEqual(['uuid-ossp::extensions'])
  })

  it('必須拡張がsourceに欠落していても（本来ありえないが）missingRequiredで検出する', () => {
    const source = [{ extname: 'pgcrypto', schema: 'extensions' }]
    const target = [{ extname: 'uuid-ossp', schema: 'extensions' }, { extname: 'pgcrypto', schema: 'extensions' }]
    const diff = compareExtensions(source, target)
    expect(diff.missingRequired).toEqual(['uuid-ossp'])
  })

  it('source限定でもREQUIRED_EXTENSIONSに含まれない拡張（Supabaseプラットフォーム拡張相当）はinformationalに分類され、missingRequiredには含まれない', () => {
    const source = [
      { extname: 'uuid-ossp', schema: 'extensions' },
      { extname: 'pgcrypto', schema: 'extensions' },
      { extname: 'pg_stat_statements', schema: 'extensions' },
    ]
    const target = [{ extname: 'uuid-ossp', schema: 'extensions' }, { extname: 'pgcrypto', schema: 'extensions' }]
    const diff = compareExtensions(source, target)
    expect(diff.missingRequired).toEqual([])
    expect(diff.onlyInSourceInformational).toEqual(['pg_stat_statements::extensions'])
    expect(diff.onlyInSource).toEqual(['pg_stat_statements::extensions'])
  })

  it('targetにしかない拡張機能はonlyInTargetとして検出する（source限定とは非対称に扱われる）', () => {
    const source = [{ extname: 'pgcrypto', schema: 'extensions' }, { extname: 'uuid-ossp', schema: 'extensions' }]
    const target = [
      { extname: 'pgcrypto', schema: 'extensions' },
      { extname: 'uuid-ossp', schema: 'extensions' },
      { extname: 'pg_trgm', schema: 'extensions' },
    ]
    const diff = compareExtensions(source, target)
    expect(diff.onlyInTarget).toEqual(['pg_trgm::extensions'])
  })

  it('同名の必須拡張でもschemaが異なればonlyInSource/onlyInTargetには載るが、missingRequiredにはならない（extname単位で判定するため）', () => {
    const source = [{ extname: 'uuid-ossp', schema: 'extensions' }, { extname: 'pgcrypto', schema: 'extensions' }]
    const target = [{ extname: 'uuid-ossp', schema: 'public' }, { extname: 'pgcrypto', schema: 'extensions' }]
    const diff = compareExtensions(source, target)
    expect(diff.missingRequired).toEqual([])
    expect(diff.onlyInSource).toEqual(['uuid-ossp::extensions'])
    expect(diff.onlyInTarget).toEqual(['uuid-ossp::public'])
  })
})

describe('extractBootstrapExtensionNames + REQUIRED_EXTENSIONS 同期テスト（オーケストレーターレビュー Minor-3対応）', () => {
  it('実際の db/planetscale/bootstrap.sql から抽出した拡張機能名が REQUIRED_EXTENSIONS と完全一致する', () => {
    const bootstrapPath = join(__dirname, '../../../db/planetscale/bootstrap.sql')
    const source = readFileSync(bootstrapPath, 'utf8')
    const found = extractBootstrapExtensionNames(source)
    expect(found).toEqual([...REQUIRED_EXTENSIONS].sort())
  })

  it('合成fixture: ハイフンを含む引用符付き拡張機能名と、引用符無しの拡張機能名の両方を抽出できる', () => {
    const source = [
      'CREATE SCHEMA IF NOT EXISTS extensions;',
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;',
      'CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;',
    ].join('\n')
    expect(extractBootstrapExtensionNames(source)).toEqual(['pgcrypto', 'uuid-ossp'])
  })

  it('CREATE EXTENSIONが無ければ空配列を返す', () => {
    expect(extractBootstrapExtensionNames('CREATE SCHEMA IF NOT EXISTS extensions;')).toEqual([])
  })
})

describe('runSchemaLayer: pg_dump失敗経路（Fableレビュー M-6対応、DB接続不要でテストできる）', () => {
  it('pg_dumpバイナリが両側とも見つからない場合、source/target双方にSCHEMA_DUMP_FAILEDを積み pass=false・objectDiff/extensionDiffはnullを返す', async () => {
    const result = await runSchemaLayer({
      sourceUrl: 'postgres://user:pass@source-host:5432/db',
      targetUrl: 'postgres://user:pass@target-host:5432/db',
      // withReadOnlySnapshotに到達する前にearly returnするため、sourceSql/targetSqlは
      // 一切呼ばれない想定（呼ばれたらこのテストはTypeErrorで失敗する）。
      sourceSql: undefined as never,
      targetSql: undefined as never,
      pgDumpBin: '/nonexistent/path/to/pg_dump',
    })
    expect(result.pass).toBe(false)
    expect(result.objectDiff).toBeNull()
    expect(result.extensionDiff).toBeNull()
    expect(result.sourceSchemaDigest).toBeNull()
    expect(result.targetSchemaDigest).toBeNull()
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'SCHEMA_DUMP_FAILED', side: 'source' }),
      expect.objectContaining({ code: 'SCHEMA_DUMP_FAILED', side: 'target' }),
    ])
  })

  it('pg_dump失敗時のエラーメッセージに接続文字列のパスワードが生値で含まれない（secret redaction）', async () => {
    const result = await runSchemaLayer({
      sourceUrl: 'postgres://user:supersecretpassword@source-host:5432/db',
      targetUrl: 'postgres://user:supersecretpassword@target-host:5432/db',
      sourceSql: undefined as never,
      targetSql: undefined as never,
      pgDumpBin: '/nonexistent/path/to/pg_dump',
    })
    const json = JSON.stringify(result)
    expect(json).not.toContain('supersecretpassword')
  })
})

describe('runSchemaLayer: normalize失敗経路（2回目Fableレビュー Minor-2対応、M-6の残課題）', () => {
  it('pg_dumpは成功するが出力がpg_dump形式でない場合、SCHEMA_NORMALIZE_FAILEDを積みpass=falseを返す', async () => {
    // /bin/echo は起動時に受け取った引数（sanitizedUrl等）をそのままstdoutへ出すだけで
    // 常にexit 0を返す。その出力にはpg_dumpのTOCヘッダー
    // （"-- Name: X; Type: Y; Schema: Z; Owner: -"）が一切含まれないため、
    // normalizeDump（splitIntoBlocks）が「TOC境界が1件も見つからない」で例外を投げる
    // （normalize-schema.mjs M-1のfail-fast設計）経路をDB接続なしで再現できる。
    const result = await runSchemaLayer({
      sourceUrl: 'postgres://user:pass@source-host:5432/db',
      targetUrl: 'postgres://user:pass@target-host:5432/db',
      sourceSql: undefined as never,
      targetSql: undefined as never,
      pgDumpBin: '/bin/echo',
    })
    expect(result.pass).toBe(false)
    expect(result.objectDiff).toBeNull()
    expect(result.extensionDiff).toBeNull()
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'SCHEMA_NORMALIZE_FAILED', side: 'source' }),
      expect.objectContaining({ code: 'SCHEMA_NORMALIZE_FAILED', side: 'target' }),
    ])
  })
})

/**
 * extension比較（fetchExtensions）だけを満たす最小限のpostgres.js互換フェイク。
 * withReadOnlySnapshot は `sql.begin(options, fn)` を呼び、fnにはtx（タグ付きテンプレート
 * 関数として呼ばれるオブジェクト）を渡す必要がある。fetchExtensionsは
 * `` await tx`select e.extname, ... ` `` という補間の無いクエリしか発行しないため、
 * txは引数を無視して固定のrowsを返す関数で十分（snapshot.test.tsのフェイクと同じ発想）。
 */
function makeFakeExtensionSql(rows: Array<{ extname: string; schema: string }> = []) {
  const tx = () => Promise.resolve(rows)
  return { begin: async (_options: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx) }
}

describe('runSchemaLayer: SCHEMA_UNEXPECTED_EXCLUSION の結線確認（2回目Fableレビュー Minor-1対応、C-1修正の保全テスト）', () => {
  it('source/target双方で同じオブジェクトが同じ理由で防御的除外された場合、findUnexpectedExclusionsの結果がfindingへ正しく反映される（無警告passにならない）', async () => {
    // C-1（1回目Fableレビュー Critical）が実際に修正されていることを、findUnexpectedExclusions
    // 単体テスト（tests/unit/db-phase2/normalize-schema.test.ts）だけでなく、runSchemaLayer内での
    // 「結線」部分（normalizeDumpの実行結果からfindingを組み立てるところ）でも確認する。
    // auth スキーマはnormalize-schema.mjsのSUPABASE_MANAGED_SCHEMASに含まれ、
    // 'public-schema-preexists' 以外の理由でexcludeされるため「想定外の除外」として扱われる。
    const fakeDump = [
      '-- PostgreSQL database dump',
      '',
      'SET statement_timeout = 0;',
      '',
      '--',
      '-- Name: leaked_table; Type: TABLE; Schema: auth; Owner: -',
      '--',
      '',
      'CREATE TABLE auth.leaked_table (id integer);',
      '',
    ].join('\n')
    const fake = writeFakePgDumpScript(fakeDump)
    try {
      // 必須拡張（uuid-ossp/pgcrypto）を両側に「存在する」フェイクにしておき、この結線テストが
      // 検証したいC-1由来のfinding（SCHEMA_UNEXPECTED_EXCLUSION）だけに焦点を絞る
      // （EXTENSION_MISMATCHが同時に出ても後続のtoEqual assertionには影響しないが、
      // arrayContainingではなくtoEqualで厳密一致を取りたい場合の伏線として揃えておく）。
      const fakeExtensionRows = REQUIRED_EXTENSIONS.map((extname) => ({ extname, schema: 'extensions' }))
      const result = await runSchemaLayer({
        sourceUrl: 'postgres://user:pass@source-host:5432/db',
        targetUrl: 'postgres://user:pass@target-host:5432/db',
        sourceSql: makeFakeExtensionSql(fakeExtensionRows) as never,
        targetSql: makeFakeExtensionSql(fakeExtensionRows) as never,
        pgDumpBin: fake.scriptPath,
      })
      expect(result.pass).toBe(false)
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SCHEMA_UNEXPECTED_EXCLUSION', side: 'source' }),
          expect.objectContaining({ code: 'SCHEMA_UNEXPECTED_EXCLUSION', side: 'target' }),
        ])
      )
      // かつ、そのオブジェクトはbring-as-isではないため diffNormalizedBlocks の比較対象からは
      // 除外され続ける（objectDiffだけを見ても検出できないことの再確認。だからこそ
      // SCHEMA_UNEXPECTED_EXCLUSIONという別チャンネルのfindingが必須だった）。
      expect(result.objectDiff).toEqual({ onlyInSource: [], onlyInTarget: [], differing: [], identicalCount: 0 })
    } finally {
      fake.cleanup()
    }
  })
})

/**
 * Issue #697 preview rehearsal followup（2026-07-22）: cutover-allowlist.mjsへの照会を
 * オブジェクト単位で分割する純粋関数のテスト（DB接続・pg_dump不要）。
 */
describe('partitionAllowlistedDifferingObjects（preview rehearsal followup）', () => {
  it('allowlist該当のcards/blob_filesと非該当のwidgetsを正しく分割する', () => {
    const result = partitionAllowlistedDifferingObjects(['TABLE::public::blob_files', 'TABLE::public::cards', 'TABLE::public::widgets'])
    expect(result.nonAllowlisted).toEqual(['TABLE::public::widgets'])
    expect(result.allowlisted).toHaveLength(2)
    expect(result.allowlisted.map((a) => a.key).sort()).toEqual(['TABLE::public::blob_files', 'TABLE::public::cards'])
    for (const a of result.allowlisted) {
      expect(a.reason.length).toBeGreaterThan(0)
    }
  })

  it('全て非該当なら allowlisted は空配列', () => {
    const result = partitionAllowlistedDifferingObjects(['TABLE::public::widgets', 'TABLE::public::streamers'])
    expect(result.allowlisted).toEqual([])
    expect(result.nonAllowlisted).toEqual(['TABLE::public::widgets', 'TABLE::public::streamers'])
  })

  it('空配列を渡せば両方とも空配列', () => {
    expect(partitionAllowlistedDifferingObjects([])).toEqual({ allowlisted: [], nonAllowlisted: [] })
  })
})

describe('partitionAllowlistedTargetExtensions（preview rehearsal followup）', () => {
  it('allowlist該当のhypopgと非該当のpg_trgmを正しく分割する', () => {
    const result = partitionAllowlistedTargetExtensions(['hypopg::pscale_extensions', 'pg_trgm::extensions'])
    expect(result.nonAllowlisted).toEqual(['pg_trgm::extensions'])
    expect(result.allowlisted).toEqual([
      { key: 'hypopg::pscale_extensions', reason: expect.stringContaining('PlanetScale') },
    ])
  })

  it('全て非該当なら allowlisted は空配列', () => {
    const result = partitionAllowlistedTargetExtensions(['pg_trgm::extensions'])
    expect(result.allowlisted).toEqual([])
    expect(result.nonAllowlisted).toEqual(['pg_trgm::extensions'])
  })

  it('空配列を渡せば両方とも空配列', () => {
    expect(partitionAllowlistedTargetExtensions([])).toEqual({ allowlisted: [], nonAllowlisted: [] })
  })

  it('Fable独立レビュー m-1対応（2026-07-22）: extname::schemaの完全一致でのみ判定する（schemaが異なるhypopgは非該当=fail維持）', () => {
    // 修正前は`extname`部分のみ（schema無視）で照合しており、`hypopg::some_other_schema`の
    // ようなPlanetScale管理外の経路（ユーザーが誤って別スキーマへインストールした等）まで
    // 誤って許容してしまっていた。`compareExtensions`が返すキー形式`extname::schema`を
    // 分解せずそのまま照会するよう修正した結果、schemaが異なれば非該当になることを確認する
    // （PlanetScaleが実際に標準搭載する`hypopg::pscale_extensions`のみが該当）。
    const result = partitionAllowlistedTargetExtensions(['hypopg::some_other_schema'])
    expect(result.allowlisted).toEqual([])
    expect(result.nonAllowlisted).toEqual(['hypopg::some_other_schema'])
  })

  it('hypopg::pscale_extensions（完全一致）はallowlist該当する', () => {
    const result = partitionAllowlistedTargetExtensions(['hypopg::pscale_extensions'])
    expect(result.nonAllowlisted).toEqual([])
    expect(result.allowlisted).toHaveLength(1)
    expect(result.allowlisted[0].key).toBe('hypopg::pscale_extensions')
  })
})

describe('runSchemaLayer: allowlist配線の統合テスト（Issue #697 preview rehearsal followup、2026-07-22）', () => {
  it('SCHEMA_OBJECT_DEFINITION_MISMATCH: allowlist該当のcards/blob_filesのみが差分ならinfoへ降格しpass=trueになる', async () => {
    const sourceDump = makeMultiTableDump([
      {
        name: 'cards',
        body:
          "CREATE TABLE public.cards (id uuid NOT NULL, rarity text, CONSTRAINT cards_rarity_not_blank " +
          "CHECK ((((rarity IS NOT NULL) AND (rarity <> ''::text)) AND (true))));",
      },
      {
        name: 'blob_files',
        body:
          "CREATE TABLE public.blob_files (id uuid NOT NULL, storage_type character varying, " +
          "CONSTRAINT valid_storage_type CHECK (((storage_type)::text = ANY ((ARRAY['r2'::character varying, " +
          "'vercel'::character varying])::text[]))));",
      },
    ])
    const targetDump = makeMultiTableDump([
      {
        name: 'cards',
        body:
          "CREATE TABLE public.cards (id uuid NOT NULL, rarity text, CONSTRAINT cards_rarity_not_blank " +
          "CHECK (((rarity IS NOT NULL) AND (rarity <> ''::text) AND (true))));",
      },
      {
        name: 'blob_files',
        body:
          "CREATE TABLE public.blob_files (id uuid NOT NULL, storage_type character varying, " +
          "CONSTRAINT valid_storage_type CHECK (((storage_type)::text = ANY (ARRAY[('r2'::character varying)::text, " +
          "('vercel'::character varying)::text]))));",
      },
    ])
    const fake = writeFakePgDumpScriptByHost(sourceDump, targetDump)
    try {
      const fakeExtensionRows = REQUIRED_EXTENSIONS.map((extname) => ({ extname, schema: 'extensions' }))
      const result = await runSchemaLayer({
        sourceUrl: 'postgres://user:pass@source-host:5432/db',
        targetUrl: 'postgres://user:pass@target-host:5432/db',
        sourceSql: makeFakeExtensionSql(fakeExtensionRows) as never,
        targetSql: makeFakeExtensionSql(fakeExtensionRows) as never,
        pgDumpBin: fake.scriptPath,
      })
      expect(result.objectDiff?.differing).toEqual(['TABLE::public::blob_files', 'TABLE::public::cards'])
      expect(result.findings).toEqual([
        expect.objectContaining({
          severity: 'info',
          code: 'SCHEMA_OBJECT_DEFINITION_MISMATCH',
          allowlisted: true,
        }),
      ])
      expect(result.pass).toBe(true)
    } finally {
      fake.cleanup()
    }
  })

  it('SCHEMA_OBJECT_DEFINITION_MISMATCH: allowlist非該当（widgets）が1件でも残ればfailし、failメッセージには非該当分のみ列挙、該当分（cards）は別のinfo findingに併記される', async () => {
    const sourceDump = makeMultiTableDump([
      {
        name: 'cards',
        body:
          "CREATE TABLE public.cards (id uuid NOT NULL, rarity text, CONSTRAINT cards_rarity_not_blank " +
          "CHECK ((((rarity IS NOT NULL) AND (rarity <> ''::text)) AND (true))));",
      },
      { name: 'widgets', body: 'CREATE TABLE public.widgets (id uuid NOT NULL, name text);' },
    ])
    const targetDump = makeMultiTableDump([
      {
        name: 'cards',
        body:
          "CREATE TABLE public.cards (id uuid NOT NULL, rarity text, CONSTRAINT cards_rarity_not_blank " +
          "CHECK (((rarity IS NOT NULL) AND (rarity <> ''::text) AND (true))));",
      },
      { name: 'widgets', body: 'CREATE TABLE public.widgets (id uuid NOT NULL, name varchar);' },
    ])
    const fake = writeFakePgDumpScriptByHost(sourceDump, targetDump)
    try {
      const fakeExtensionRows = REQUIRED_EXTENSIONS.map((extname) => ({ extname, schema: 'extensions' }))
      const result = await runSchemaLayer({
        sourceUrl: 'postgres://user:pass@source-host:5432/db',
        targetUrl: 'postgres://user:pass@target-host:5432/db',
        sourceSql: makeFakeExtensionSql(fakeExtensionRows) as never,
        targetSql: makeFakeExtensionSql(fakeExtensionRows) as never,
        pgDumpBin: fake.scriptPath,
      })
      expect(result.pass).toBe(false)
      const failFinding = result.findings.find((f: { code: string; severity: string }) => f.code === 'SCHEMA_OBJECT_DEFINITION_MISMATCH' && f.severity === 'fail')
      expect(failFinding).toBeDefined()
      expect((failFinding as { message: string }).message).toContain('TABLE::public::widgets')
      expect((failFinding as { message: string }).message).not.toContain('TABLE::public::cards')

      const infoFinding = result.findings.find((f: { code: string; severity: string }) => f.code === 'SCHEMA_OBJECT_DEFINITION_MISMATCH' && f.severity === 'info')
      expect(infoFinding).toEqual(expect.objectContaining({ allowlisted: true }))
      expect((infoFinding as { message: string }).message).toContain('TABLE::public::cards')
    } finally {
      fake.cleanup()
    }
  })

  it('EXTENSION_MISMATCH: target限定のhypopgのみならinfoへ降格しpass=trueになる', async () => {
    const dump = makeMultiTableDump([{ name: 'widgets', body: 'CREATE TABLE public.widgets (id uuid NOT NULL);' }])
    const fake = writeFakePgDumpScriptByHost(dump, dump)
    try {
      const sourceExtensionRows = REQUIRED_EXTENSIONS.map((extname) => ({ extname, schema: 'extensions' }))
      const targetExtensionRows = [...sourceExtensionRows, { extname: 'hypopg', schema: 'pscale_extensions' }]
      const result = await runSchemaLayer({
        sourceUrl: 'postgres://user:pass@source-host:5432/db',
        targetUrl: 'postgres://user:pass@target-host:5432/db',
        sourceSql: makeFakeExtensionSql(sourceExtensionRows) as never,
        targetSql: makeFakeExtensionSql(targetExtensionRows) as never,
        pgDumpBin: fake.scriptPath,
      })
      expect(result.extensionDiff?.onlyInTarget).toEqual(['hypopg::pscale_extensions'])
      expect(result.findings).toEqual([
        expect.objectContaining({ severity: 'info', code: 'EXTENSION_MISMATCH', allowlisted: true, side: 'target' }),
      ])
      expect(result.pass).toBe(true)
    } finally {
      fake.cleanup()
    }
  })

  it('EXTENSION_MISMATCH: target限定のhypopg（allowlist該当）とpg_trgm（非該当）が両方あれば、非該当分のみでfailし該当分はinfoに併記される。pass=false', async () => {
    const dump = makeMultiTableDump([{ name: 'widgets', body: 'CREATE TABLE public.widgets (id uuid NOT NULL);' }])
    const fake = writeFakePgDumpScriptByHost(dump, dump)
    try {
      const sourceExtensionRows = REQUIRED_EXTENSIONS.map((extname) => ({ extname, schema: 'extensions' }))
      const targetExtensionRows = [
        ...sourceExtensionRows,
        { extname: 'hypopg', schema: 'pscale_extensions' },
        { extname: 'pg_trgm', schema: 'extensions' },
      ]
      const result = await runSchemaLayer({
        sourceUrl: 'postgres://user:pass@source-host:5432/db',
        targetUrl: 'postgres://user:pass@target-host:5432/db',
        sourceSql: makeFakeExtensionSql(sourceExtensionRows) as never,
        targetSql: makeFakeExtensionSql(targetExtensionRows) as never,
        pgDumpBin: fake.scriptPath,
      })
      expect(result.pass).toBe(false)
      const failFinding = result.findings.find((f: { code: string; severity: string }) => f.code === 'EXTENSION_MISMATCH' && f.severity === 'fail')
      expect(failFinding).toBeDefined()
      expect((failFinding as { message: string }).message).toContain('pg_trgm::extensions')
      expect((failFinding as { message: string }).message).not.toContain('hypopg')

      const infoFinding = result.findings.find((f: { code: string; severity: string }) => f.code === 'EXTENSION_MISMATCH' && f.severity === 'info')
      expect(infoFinding).toBeDefined()
      expect((infoFinding as { message: string }).message).toContain('hypopg::pscale_extensions')
    } finally {
      fake.cleanup()
    }
  })

  it('EXTENSION_MISMATCH: source側で必須拡張（uuid-ossp）が欠落している場合、hypopgがtarget限定で存在しても降格されず必ずfailする（source側欠落は絶対に降格しない）', async () => {
    const dump = makeMultiTableDump([{ name: 'widgets', body: 'CREATE TABLE public.widgets (id uuid NOT NULL);' }])
    const fake = writeFakePgDumpScriptByHost(dump, dump)
    try {
      // sourceにはuuid-osspが無い（本来ありえないが、必須拡張欠落のケースを構成する）。
      const sourceExtensionRows = [{ extname: 'pgcrypto', schema: 'extensions' }]
      const targetExtensionRows = [
        { extname: 'uuid-ossp', schema: 'extensions' },
        { extname: 'pgcrypto', schema: 'extensions' },
        { extname: 'hypopg', schema: 'pscale_extensions' },
      ]
      const result = await runSchemaLayer({
        sourceUrl: 'postgres://user:pass@source-host:5432/db',
        targetUrl: 'postgres://user:pass@target-host:5432/db',
        sourceSql: makeFakeExtensionSql(sourceExtensionRows) as never,
        targetSql: makeFakeExtensionSql(targetExtensionRows) as never,
        pgDumpBin: fake.scriptPath,
      })
      expect(result.extensionDiff?.missingRequired).toEqual(['uuid-ossp'])
      expect(result.pass).toBe(false)
      const failFinding = result.findings.find((f: { code: string; severity: string }) => f.code === 'EXTENSION_MISMATCH' && f.severity === 'fail')
      expect(failFinding).toBeDefined()
      expect((failFinding as { message: string }).message).toContain('uuid-ossp')
      // hypopg自体はtarget限定かつallowlist該当のため、別チャンネルのinfo findingとしても現れる
      // （failするからといってhypopgのinfo降格が握りつぶされるわけではない）。
      const infoFinding = result.findings.find((f: { code: string; severity: string }) => f.code === 'EXTENSION_MISMATCH' && f.severity === 'info')
      expect(infoFinding).toBeDefined()
    } finally {
      fake.cleanup()
    }
  })
})
