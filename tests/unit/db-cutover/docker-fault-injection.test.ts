import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync, execFileSync, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { createServer } from 'net'
import postgres, { type Sql } from 'postgres'
import { runIdentityLayer } from '../../../scripts/db-cutover/layer-identity.mjs'
import { runSchemaLayer } from '../../../scripts/db-cutover/layer-schema.mjs'
import { ensureIdentitySchema, seedIdentity } from '../../../scripts/db-cutover/identity-store.mjs'
import { withReadOnlySnapshot } from '../../../scripts/db-cutover/snapshot.mjs'

/**
 * Docker実機での故障注入統合テスト（Issue #697 Chunk 1タスク10、Major必須項目）。
 *
 * 目的: 単体テスト（純粋関数へのfixture入力）だけでは「実際にPostgresへ接続してこの
 * ツールを動かしたときに、意図したfailケースを本当に検出できるか」までは確認できない。
 * 本テストはローカルDocker上に2台のPostgresコンテナを起動し、実際に
 * runIdentityLayer/runSchemaLayer（cutover検証ツールの中核ロジック）を実DB接続で実行し、
 * 以下がfailとして検出されることを確認する:
 *   1. 同一DBをsource/targetに指定した場合（instance_id一致で即fail）
 *   2. --source-environment/--target-environment 相当の期待値とDB上の実際の値が食い違う場合
 *   3. target側の1テーブルに列追加を行った場合、schema比較がfailを報告する
 *   4. BYPASSRLSを持たないロールで接続した場合、Layer 1がfailを報告する
 *
 * 既存のDocker検証手順（docs/planetscale-schema-baseline.md 4章）を踏襲し、
 * db/planetscale/bootstrap.sql → db/planetscale/public-schema.sql の順で適用してから検証する。
 *
 * 実行方法（ローカルでのみ、明示的なopt-inが必要）:
 *   RUN_DB_CUTOVER_DOCKER_TESTS=1 npx vitest run tests/unit/db-cutover/docker-fault-injection.test.ts
 *
 * 環境変数でのスキップについて（オーケストレーターレビュー N-1対応、当初の実装を修正）:
 * 当初は「Docker daemonが起動していない、またはpg_dump/psqlバイナリが見つからない環境では
 * 自動的にスキップする」という自動検出のみだった。しかしこれには次のリスクがあった:
 * `npm run test:unit` は `.github/workflows/ci.yml` の Unit tests ステップで `--bail=1`
 * 付きで実行されるため、CI環境（GitHub Actions ubuntu-latest）にDockerは確実にあるが、
 * psql/pg_dumpの有無・そのメジャーバージョンが起動するイメージ（`postgres:17`、下記
 * POSTGRES_IMAGE）と一致するかは未確認・未保証だった。もしランナーに古いバージョンの
 * pg_dumpが入っていた場合、`pg_dump: error: aborting because of server version mismatch`
 * のようなエラーで本テストがfailし、CI全体を巻き添えにするおそれがあった
 * （このファイル自身が「CI環境でDocker 2台起動するコストを常時払わせない」という意図を
 * コメントに明記していたにもかかわらず、実装（バイナリ自動検出のみ）ではその意図を
 * 保証できていなかった）。
 *
 * 対策: `RUN_DB_CUTOVER_DOCKER_TESTS=1` という明示的なopt-in環境変数を必須にし、
 * これが設定されていない限り（CIも含め）常にスキップする。バイナリの自動検出
 * （dockerAvailable/psqlBin/pgDumpBin）は「opt-inした場合に実際に実行可能かどうか」の
 * 判定としてのみ残す（opt-inしたのに前提条件が揃っていない場合は明確なエラーメッセージで
 * 案内するため）。
 */

const TEST_ID = `${process.pid}-${Date.now()}`
const SOURCE_CONTAINER = `twica-cutover-test-source-${TEST_ID}`
const TARGET_CONTAINER = `twica-cutover-test-target-${TEST_ID}`
const POSTGRES_IMAGE = 'postgres:17'
const POSTGRES_PASSWORD = 'cutover-test-devpass'

const REPO_ROOT = join(__dirname, '../../..')
const BOOTSTRAP_SQL = join(REPO_ROOT, 'db/planetscale/bootstrap.sql')
const PUBLIC_SCHEMA_SQL = join(REPO_ROOT, 'db/planetscale/public-schema.sql')

/**
 * OSに空きポートを1つ割り当てさせる（Fableレビュー Minor-10対応）。
 * 以前は55461/55462の固定ポートを使っていたが、同一マシンでこのテストを並行実行した場合や、
 * 他プロセスが偶然同じポートを使っている場合に衝突しうる。`net.createServer().listen(0)` で
 * OSにポート0（=空きポートを自動割り当て）をbindさせ、割り当てられたポート番号だけを読み取って
 * 即座にサーバーを閉じる（実際にそのポートを使うのはこの後起動するdocker containerのため、
 * ここではポート番号を確保する目的のみ）。
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('getFreePort: failed to determine assigned port')))
      }
    })
  })
}

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 8000 })
    return true
  } catch {
    return false
  }
}

/**
 * name（psql/pg_dump）の実行可能ファイルパスを解決する。PATH上に無い場合、
 * Homebrewのkeg-only postgresql@17のインストール先を候補として探す
 * （本プロジェクトのCLIツール自体はPG_DUMP_BIN環境変数で経路を指定させる設計だが、
 * このテストファイル自身が検証用に直接psql/pg_dumpを呼ぶ箇所ではPATH解決の便宜を図る。
 * 本番運用のredaction/接続文字列の扱いには影響しないテスト専用のヘルパー）。
 */
function resolveBinary(name: string): string | null {
  try {
    const found = execSync(`command -v ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (found) return found
  } catch {
    // PATH上に無い場合は下のcandidatesにフォールバックする
  }
  const candidates = [
    `/opt/homebrew/opt/postgresql@17/bin/${name}`,
    `/usr/local/opt/postgresql@17/bin/${name}`,
    `/opt/homebrew/opt/postgresql/bin/${name}`,
    `/usr/local/opt/postgresql/bin/${name}`,
  ]
  return candidates.find((c) => existsSync(c)) ?? null
}

// オーケストレーターレビュー N-1対応: 明示的なopt-inが無い限り、Docker/psql/pg_dumpの
// 自動検出すら行わない（CI環境で不要な`docker info`等のサブプロセス起動コストも避ける）。
const optedIn = process.env.RUN_DB_CUTOVER_DOCKER_TESTS === '1'

const dockerAvailable = optedIn ? isDockerAvailable() : false
const psqlBin = optedIn && dockerAvailable ? resolveBinary('psql') : null
const pgDumpBin = optedIn && dockerAvailable ? resolveBinary('pg_dump') : null
const canRun = optedIn && dockerAvailable && !!psqlBin && !!pgDumpBin && existsSync(BOOTSTRAP_SQL) && existsSync(PUBLIC_SCHEMA_SQL)

if (!optedIn) {
  console.warn(
    '[docker-fault-injection.test.ts] スキップします（RUN_DB_CUTOVER_DOCKER_TESTS=1 が' +
      '設定されていません）。ローカルでDocker実機検証する場合は次のように実行してください: ' +
      'RUN_DB_CUTOVER_DOCKER_TESTS=1 npx vitest run tests/unit/db-cutover/docker-fault-injection.test.ts'
  )
} else if (!canRun) {
  console.warn(
    `[docker-fault-injection.test.ts] RUN_DB_CUTOVER_DOCKER_TESTS=1 が設定されていますが、` +
      `前提条件が揃っていないためスキップします（docker=${dockerAvailable} psql=${!!psqlBin} pg_dump=${!!pgDumpBin}）。` +
      'Docker Desktopを起動し、psql/pg_dumpがPATHまたはHomebrew既定パスから解決できる状態で再実行してください。'
  )
}

function runPsqlFile(port: number, filePath: string) {
  // -1 (単一トランザクション) が必須: public-schema.sql の preamble にある
  // `SET LOCAL check_function_bodies = false;` はトランザクション内でのみ有効で、
  // これが効いていないと関数定義順序によっては前方参照（後で定義されるテーブルを
  // 参照する関数）でエラーになる（docs/planetscale-schema-baseline.md 1.1節・4章の
  // 手動適用コマンドが `-1` を使っているのと同じ理由。実際にこのテストの初回実装時、
  // `-1` を付け忘れて `relation "card_stone_transactions" does not exist` で
  // 失敗することを実機で確認した）。
  execFileSync(
    psqlBin as string,
    ['-1', '-v', 'ON_ERROR_STOP=1', '-q', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-f', filePath],
    { env: { ...process.env, PGPASSWORD: POSTGRES_PASSWORD }, stdio: 'pipe' }
  )
}

function runPsqlCommand(port: number, sqlText: string) {
  execFileSync(
    psqlBin as string,
    ['-v', 'ON_ERROR_STOP=1', '-q', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-c', sqlText],
    { env: { ...process.env, PGPASSWORD: POSTGRES_PASSWORD }, stdio: 'pipe' }
  )
}

async function waitForReady(port: number, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      execFileSync(psqlBin as string, ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-c', 'select 1'], {
        env: { ...process.env, PGPASSWORD: POSTGRES_PASSWORD },
        stdio: 'pipe',
      })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`Postgres (port ${port}) がタイムアウト内に準備完了しませんでした: ${String(lastError)}`)
}

function startContainer(name: string, port: number) {
  // Minor-10（Fableレビュー）: 以前は2コンテナを同じdocker networkに参加させていたが、
  // このテストはコンテナ間通信を一切行わない（テストプロセスからホストの公開ポート経由で
  // 各コンテナへ個別に接続するのみ）ため、network自体が不要だった（YAGNI）。作成・削除の
  // 手間とタイミング依存の後片付け失敗リスクを削減するため撤去する。
  execSync(`docker run -d --name ${name} -e POSTGRES_PASSWORD=${POSTGRES_PASSWORD} -p ${port}:5432 ${POSTGRES_IMAGE}`, {
    stdio: 'pipe',
  })
}

function removeContainer(name: string) {
  try {
    execSync(`docker rm -f ${name}`, { stdio: 'ignore' })
  } catch {
    // 既に存在しない場合は無視（beforeAllが途中で失敗した場合のafterAllからの呼び出し等）
  }
}

/**
 * db-cutover配下のCLIスクリプト（verify.mjs/init-identity.mjs）を実際に子プロセスとして起動する
 * ヘルパー（オーケストレーターレビュー M-2対応）。
 *
 * 背景: `verify.mjs`のmain()・`init-identity.mjs`のmain()は非exportで、132件の既存単体テストは
 * いずれもLayer関数（runIdentityLayer/runSchemaLayer等）を直接呼び出すのみで、実際のCLI
 * エントリポイント（引数解析→実行→exit code→stdout JSON出力という一連の配線）を一度も
 * 通していなかった。本ヘルパーで実プロセスとしてCLIを起動し、ブラックボックスに
 * stdout/stderr/exit codeだけを見て検証することで、「実際にユーザーが叩くコマンドが
 * 意図通り動くか」を担保する。
 */
function runNodeScript(scriptRelPath: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [join(REPO_ROOT, scriptRelPath), ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

describe.skipIf(!canRun)('db-cutover Docker fault injection (Issue #697 Chunk 1)', () => {
  let sourceSql: Sql
  let targetSql: Sql
  // Minor-10（Fableレビュー）対応: 固定ポート（旧: 55461/55462）は同一マシンでの並行実行や
  // 他プロセスとの衝突リスクがあったため、OSに動的割り当てさせる（getFreePort参照）。
  let SOURCE_PORT: number
  let TARGET_PORT: number

  beforeAll(async () => {
    ;[SOURCE_PORT, TARGET_PORT] = await Promise.all([getFreePort(), getFreePort()])
    startContainer(SOURCE_CONTAINER, SOURCE_PORT)
    startContainer(TARGET_CONTAINER, TARGET_PORT)
    await Promise.all([waitForReady(SOURCE_PORT), waitForReady(TARGET_PORT)])

    // docs/planetscale-schema-baseline.md 4章と同じ適用順序: bootstrap.sql → public-schema.sql
    for (const port of [SOURCE_PORT, TARGET_PORT]) {
      runPsqlFile(port, BOOTSTRAP_SQL)
      runPsqlFile(port, PUBLIC_SCHEMA_SQL)
    }

    sourceSql = postgres({ host: '127.0.0.1', port: SOURCE_PORT, user: 'postgres', password: POSTGRES_PASSWORD, database: 'postgres', max: 1 })
    targetSql = postgres({ host: '127.0.0.1', port: TARGET_PORT, user: 'postgres', password: POSTGRES_PASSWORD, database: 'postgres', max: 1 })

    await ensureIdentitySchema(sourceSql)
    await ensureIdentitySchema(targetSql)
    await seedIdentity(sourceSql, { environment: 'preview', provider: 'supabase', force: false })
    await seedIdentity(targetSql, { environment: 'preview', provider: 'planetscale', force: false })

    // BYPASSRLSテスト用の非特権ロールをsourceコンテナに作成する。
    // twica_meta.database_identity を読める（GRANT済み）が BYPASSRLS は持たないロール。
    runPsqlCommand(
      SOURCE_PORT,
      `CREATE ROLE cutover_test_nobypass LOGIN PASSWORD '${POSTGRES_PASSWORD}'; ` +
        `GRANT USAGE ON SCHEMA twica_meta TO cutover_test_nobypass; ` +
        `GRANT SELECT ON twica_meta.database_identity TO cutover_test_nobypass;`
    )
  }, 120000)

  afterAll(async () => {
    await sourceSql?.end({ timeout: 5 })
    await targetSql?.end({ timeout: 5 })
    removeContainer(SOURCE_CONTAINER)
    removeContainer(TARGET_CONTAINER)
  }, 60000)

  it('sanity: 正しくseedされたsource/targetはidentity layerをpassする', async () => {
    const result = await runIdentityLayer({
      sourceSql,
      targetSql,
      expected: { sourceEnvironment: 'preview', sourceProvider: 'supabase', targetEnvironment: 'preview', targetProvider: 'planetscale' },
    })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  })

  it('sanity: ドリフトの無いsource/targetはschema layerをpassする', async () => {
    const result = await runSchemaLayer({
      sourceUrl: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
      targetUrl: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
      sourceSql,
      targetSql,
      pgDumpBin: pgDumpBin as string,
    })
    expect(result.pass).toBe(true)
    expect(result.findings).toEqual([])
  }, 30000)

  it('sanity: withReadOnlySnapshot内でのINSERTは実DBのREAD ONLY制約により拒否される（Fableレビュー M-5対応、実機での多重防御確認）', async () => {
    // 単体テスト（snapshot.test.ts）はJSレベルの「常にROLLBACKさせる」契約をフェイクで検証するが、
    // 実際に `ISOLATION LEVEL REPEATABLE READ READ ONLY` がPostgresへ届いていること、
    // およびそのトランザクション内での書き込みがPostgres自身によって拒否されることは
    // 実DBでしか確認できない（ファイル冒頭コメント冒頭のwithReadOnlySnapshot設計の
    // 「多重防御」がこのテストで裏取りされる）。
    await expect(
      withReadOnlySnapshot(sourceSql, async (tx) => {
        // gen_random_uuid()はpgcryptoの設置スキーマ（extensions）がsearch_pathに無いと
        // 未修飾では解決できない場合があるため、固定UUIDリテラルを使い拡張機能への依存を避ける。
        await tx.unsafe(
          "insert into twica_meta.database_identity (environment, provider, instance_id, initialized_at) " +
            "values ('should-fail', 'supabase', '00000000-0000-0000-0000-000000000000', now())"
        )
      })
    ).rejects.toThrow(/read-only transaction/i)

    // 書き込みが本当に反映されていない（＝ROLLBACKが機能している）ことも確認する。
    const rows = await sourceSql`select environment from twica_meta.database_identity where environment = 'should-fail'`
    expect(rows).toHaveLength(0)
  })

  it('故障注入1: 同一DBをsource/targetに指定するとinstance_id一致でfailする', async () => {
    const result = await runIdentityLayer({
      sourceSql,
      targetSql: sourceSql,
      expected: { sourceEnvironment: 'preview', sourceProvider: 'supabase', targetEnvironment: 'preview', targetProvider: 'supabase' },
    })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'IDENTITY_INSTANCE_ID_COLLISION' })])
    )
  })

  it('故障注入2: --target-environment の期待値とDB上の実際の値が食い違うとfailする', async () => {
    const result = await runIdentityLayer({
      sourceSql,
      targetSql,
      // 実際のtargetは environment='preview' でseedされているが、期待値としてproductionを渡す
      // （prod/preview取り違えの検知シナリオ）。
      expected: { sourceEnvironment: 'preview', sourceProvider: 'supabase', targetEnvironment: 'production', targetProvider: 'planetscale' },
    })
    expect(result.pass).toBe(false)
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ENVIRONMENT_MISMATCH', side: 'target' })])
    )
  })

  it('故障注入3: target側のcardsテーブルに列追加すると schema layer がfailを報告する', async () => {
    await targetSql.unsafe('ALTER TABLE public.cards ADD COLUMN cutover_test_extra_column text')
    try {
      const result = await runSchemaLayer({
        sourceUrl: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
        targetUrl: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
        sourceSql,
        targetSql,
        pgDumpBin: pgDumpBin as string,
      })
      expect(result.pass).toBe(false)
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SCHEMA_OBJECT_DEFINITION_MISMATCH', message: expect.stringContaining('TABLE::public::cards') }),
        ])
      )
    } finally {
      await targetSql.unsafe('ALTER TABLE public.cards DROP COLUMN cutover_test_extra_column')
    }
  }, 30000)

  it('故障注入4: BYPASSRLSを持たないロールで接続するとLayer 1がfailを報告する', async () => {
    const nobypassSql = postgres({
      host: '127.0.0.1',
      port: SOURCE_PORT,
      user: 'cutover_test_nobypass',
      password: POSTGRES_PASSWORD,
      database: 'postgres',
      max: 1,
    })
    try {
      const result = await runIdentityLayer({
        sourceSql: nobypassSql,
        targetSql,
        expected: { sourceEnvironment: 'preview', sourceProvider: 'supabase', targetEnvironment: 'preview', targetProvider: 'planetscale' },
      })
      expect(result.pass).toBe(false)
      expect(result.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'BYPASSRLS_REQUIRED', side: 'source' })])
      )
    } finally {
      await nobypassSql.end({ timeout: 5 })
    }
  })

  it('E2E（オーケストレーターレビュー M-2対応）: verify.mjs CLIをsubprocessとして実行し、environment取り違えでidentity layerがfailすると schema layer が notEvaluated のまま report される', async () => {
    // --target-environment=production を指定するため、CLIのprod安全ガード
    // （production関与時は--operation-id必須）を満たす値も付与する。これはこのテストが
    // 検証したい「identity layerでのenvironment不一致検知」とは別のガードであり、
    // 満たさないとバリデーションエラーで即終了しreport自体が生成されない
    // （手動デバッグでこの点を実機確認済み）。
    const result = runNodeScript(
      'scripts/db-cutover/verify.mjs',
      [
        '--source-environment=preview',
        '--source-provider=supabase',
        '--target-environment=production',
        '--target-provider=planetscale',
        '--layers=identity,schema',
        '--operation-id=e2e-test-environment-mismatch',
      ],
      {
        SOURCE_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
        TARGET_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
        PG_DUMP_BIN: pgDumpBin as string,
      }
    )
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout)
    expect(report.decision).toBe('fail')
    expect(report.layers.identity.pass).toBe(false)
    // schema layerは--layersに含めて要求したが、identity layerがfailした時点で
    // 実行を停止するため「実行されなかった」状態のまま report される。
    expect(report.layers.schema).toEqual({ layer: 'schema', pass: null, findings: [], notEvaluated: true })
    // secret redaction: stdout/stderrいずれにも接続文字列のパスワードが生値で出ないこと。
    expect(result.stdout).not.toContain(POSTGRES_PASSWORD)
    expect(result.stderr).not.toContain(POSTGRES_PASSWORD)
  }, 30000)

  it('E2E（オーケストレーターレビュー M-2対応）: verify.mjs CLIでsource/targetが正しく揃っていれば identity/schema 両方passし、decision=pass・終了コード0でJSON reportが標準出力される', async () => {
    const result = runNodeScript(
      'scripts/db-cutover/verify.mjs',
      [
        '--source-environment=preview',
        '--source-provider=supabase',
        '--target-environment=preview',
        '--target-provider=planetscale',
        '--layers=identity,schema',
      ],
      {
        SOURCE_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
        TARGET_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
        PG_DUMP_BIN: pgDumpBin as string,
      }
    )
    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.decision).toBe('pass')
    expect(report.layers.identity.pass).toBe(true)
    expect(report.layers.schema.pass).toBe(true)
    expect(report.schemaVersion).toBe(1)
  }, 30000)

  it('E2E（オーケストレーターレビュー M-2対応）: init-identity.mjs CLIは既存行があるとdefaultで拒否し、--force指定時のみinstance_idを保ったまま上書きに成功する', async () => {
    const sourceUrl = `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`
    const before = await sourceSql`select instance_id, environment, provider from twica_meta.database_identity`
    expect(before).toHaveLength(1)
    const originalInstanceId = before[0].instance_id

    // --force無し: 既存行があるため拒否される（exit 1）。
    const rejected = runNodeScript(
      'scripts/db-cutover/init-identity.mjs',
      ['--environment=preview', '--provider=supabase'],
      { DATABASE_URL: sourceUrl }
    )
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toMatch(/既に.*行が存在/)

    // --force指定: 同じ値で「上書き」が成功する（exit 0）。instance_idは変わらないはず。
    const forced = runNodeScript(
      'scripts/db-cutover/init-identity.mjs',
      ['--environment=preview', '--provider=supabase', '--force'],
      { DATABASE_URL: sourceUrl }
    )
    expect(forced.status).toBe(0)
    expect(forced.stdout).toMatch(/instance_id は初回seed時の値を維持/)

    const after = await sourceSql`select instance_id, environment, provider from twica_meta.database_identity`
    expect(after).toHaveLength(1)
    expect(after[0].instance_id).toBe(originalInstanceId)
    expect(after[0].environment).toBe('preview')
    expect(after[0].provider).toBe('supabase')

    // secret redaction: パスワードが生値で出力されていないこと。
    expect(rejected.stdout + rejected.stderr).not.toContain(POSTGRES_PASSWORD)
    expect(forced.stdout + forced.stderr).not.toContain(POSTGRES_PASSWORD)
  })
})
