import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync, execFileSync, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { createServer } from 'net'
import postgres, { type Sql } from 'postgres'
import { runIdentityLayer } from '../../../scripts/db-cutover/layer-identity.mjs'
import { runSchemaLayer } from '../../../scripts/db-cutover/layer-schema.mjs'
import { runDataLayer } from '../../../scripts/db-cutover/layer-data.mjs'
import { runInvariantsLayer } from '../../../scripts/db-cutover/layer-invariants.mjs'
import { runCanaryLayer, buildFixtureIdentifiers } from '../../../scripts/db-cutover/layer-canary.mjs'
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
 *   3. target側の1テーブル（allowlist非対象、`users`）に列追加を行った場合、schema比較が
 *      failを報告する（2026-07-22注記: 以前は`cards`テーブルで検証していたが、cardsは
 *      preview rehearsalで判明したPG 17.6/17.10のCHECK制約deparse差を許容するため
 *      allowlist化され、cardsへの列追加はもはやfailを誘発しない。その正例〔allowlist該当分は
 *      info降格されつつ、他の非対象テーブルの差分はfailが維持されること〕は
 *      「故障注入3-allowlist」で別途検証する）
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

describe.skipIf(!canRun)('db-cutover Docker fault injection (Issue #697 Chunk 1 + Chunk 2 + Chunk 3 + Chunk 4)', () => {
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

  it('故障注入3: target側のusersテーブルに列追加すると schema layer がfailを報告する', async () => {
    // 2026-07-22注記（オーケストレーター実測レビュー対応）: 本テストは元々
    // `public.cards`への列追加でfailを誘発していたが、cardsは同日にpreview rehearsalで
    // 判明したPG 17.6(Supabase)/17.10(PlanetScale)のCHECK制約deparse差を許容するため
    // `cutover-allowlist.mjs`の`CHECK_CONSTRAINT_DEPARSE_VERSION_DIFF`エントリで
    // allowlist化された（対象はTABLEオブジェクト単位のため、deparse差に限らずcardsの
    // 定義差分全般がinfoへ降格される）。そのためcardsへの列追加はもはやfailを誘発せず
    // schema layerがpassしてしまう（＝allowlistが意図どおり機能している証拠でもある。
    // その正例は下記の別テストで検証する）。本テストの目的（schema layerが定義差分を
    // failで検出すること）を維持するため、故障注入先をallowlist非対象の`users`テーブルへ
    // 変更した。
    await targetSql.unsafe('ALTER TABLE public.users ADD COLUMN cutover_test_extra_column text')
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
          expect.objectContaining({ code: 'SCHEMA_OBJECT_DEFINITION_MISMATCH', message: expect.stringContaining('TABLE::public::users') }),
        ])
      )
    } finally {
      await targetSql.unsafe('ALTER TABLE public.users DROP COLUMN cutover_test_extra_column')
    }
  }, 30000)

  it('故障注入3-allowlist（2026-07-22追加）: target側のcardsテーブルへの列追加はCHECK_CONSTRAINT_DEPARSE_VERSION_DIFFエントリによりinfo（allowlisted:true）へ降格されschema layerはpassする。ただし非対象テーブル（users）への変更が同時にあればfailは維持される', async () => {
    // cards/blob_filesはPG 17.6(Supabase)/17.10(PlanetScale)のCHECK制約deparse差を
    // 許容するため2026-07-22にallowlist化された（cutover-allowlist.mjsの
    // CHECK_CONSTRAINT_DEPARSE_VERSION_DIFFエントリ）。マッチングはオブジェクト単位
    // （`TABLE::public::cards`というキー全体）で行われるため、deparse差に限らず
    // cardsテーブルの定義差分全般がinfoへ降格される（この縮退自体はallowlistエントリの
    // reasonに明記済みの既知の緩和策/残余ギャップ）。まずcardsのみへ列追加し、
    // schema layerがpass=trueになる（allowlistの正例）ことを確認する。
    await targetSql.unsafe('ALTER TABLE public.cards ADD COLUMN cutover_test_allowlisted_column text')
    try {
      const cardsOnlyResult = await runSchemaLayer({
        sourceUrl: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
        targetUrl: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
        sourceSql,
        targetSql,
        pgDumpBin: pgDumpBin as string,
      })
      expect(cardsOnlyResult.pass).toBe(true)
      expect(cardsOnlyResult.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'info',
            code: 'SCHEMA_OBJECT_DEFINITION_MISMATCH',
            allowlisted: true,
            message: expect.stringContaining('TABLE::public::cards'),
          }),
        ])
      )
      expect(cardsOnlyResult.findings).not.toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'fail' })]))

      // 続けてusers（allowlist非対象）にも列追加し、混在ケースを検証する。cardsのinfo降格は
      // 維持されたまま、usersの差分のみでfailすることを確認する（1オブジェクト単位の
      // 判定であり、allowlist該当が他の非該当差分まで一括で握りつぶさないことの実機確認）。
      await targetSql.unsafe('ALTER TABLE public.users ADD COLUMN cutover_test_mixed_column text')
      try {
        const mixedResult = await runSchemaLayer({
          sourceUrl: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
          targetUrl: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
          sourceSql,
          targetSql,
          pgDumpBin: pgDumpBin as string,
        })
        expect(mixedResult.pass).toBe(false)
        expect(mixedResult.findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              severity: 'fail',
              code: 'SCHEMA_OBJECT_DEFINITION_MISMATCH',
              message: expect.stringContaining('TABLE::public::users'),
            }),
            expect.objectContaining({
              severity: 'info',
              code: 'SCHEMA_OBJECT_DEFINITION_MISMATCH',
              allowlisted: true,
              message: expect.stringContaining('TABLE::public::cards'),
            }),
          ])
        )
        // failのmessageにはusers（非該当分）のみが列挙され、allowlist該当のcardsは
        // 混入しない（layer-schema.mjsのpartitionAllowlistedDifferingObjects: 非該当分のみを
        // fail findingへ列挙し、該当分は別チャンネルのinfo findingへ回す設計の実機確認）。
        const failFinding = mixedResult.findings.find(
          (f: { severity: string; code: string }) => f.severity === 'fail' && f.code === 'SCHEMA_OBJECT_DEFINITION_MISMATCH'
        )
        expect((failFinding as { message: string }).message).not.toContain('TABLE::public::cards')
      } finally {
        await targetSql.unsafe('ALTER TABLE public.users DROP COLUMN cutover_test_mixed_column')
      }
    } finally {
      await targetSql.unsafe('ALTER TABLE public.cards DROP COLUMN cutover_test_allowlisted_column')
    }
  }, 60000)

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

  describe('data layer（Issue #697 Chunk 2、Layer 3 件数/key range統計 + Layer 4 checksum）', () => {
    // 固定UUID・固定timestampでsource/targetへ同一のfixtureをseedする。ランダム生成
    // （uuid_generate_v4()等のDB側デフォルト）に頼ると、source/target別々の接続で
    // 生成した値が一致せず「同一データのはずがchecksum不一致になる」という、この
    // テストの目的とは無関係な偽陽性を生む（実装時に手元検証で実際に踏んだ問題）。
    const FIXTURE_STREAMER_ID = '99999999-9999-9999-9999-999999999991'
    const FIXTURE_USER_ID = '99999999-9999-9999-9999-999999999992'
    const FIXTURE_CARD_IDS = [0, 1, 2, 3, 4].map((i) => `99999999-9999-9999-9999-99999999a00${i}`)
    const FIXTURE_TS = '2026-01-01T00:00:00.000Z'
    const FIXTURE_SECRET_TOKEN = 'cutover-test-fixture-secret-token-value'

    async function seedFixture(sql: Sql) {
      await sql`delete from cards where streamer_id = ${FIXTURE_STREAMER_ID}`
      await sql`delete from users where id = ${FIXTURE_USER_ID}`
      await sql`delete from streamers where id = ${FIXTURE_STREAMER_ID}`
      await sql`insert into streamers (id, twitch_user_id, twitch_username, twitch_display_name, created_at, updated_at)
        values (${FIXTURE_STREAMER_ID}, 'fixture-streamer', 'fixture', 'Fixture', ${FIXTURE_TS}, ${FIXTURE_TS})`
      await sql`insert into users (id, twitch_user_id, twitch_username, twitch_display_name, twitch_access_token, created_at, updated_at)
        values (${FIXTURE_USER_ID}, 'fixture-user', 'fixtureuser', 'FixtureUser', ${FIXTURE_SECRET_TOKEN}, ${FIXTURE_TS}, ${FIXTURE_TS})`
      for (const cardId of FIXTURE_CARD_IDS) {
        await sql`insert into cards (id, streamer_id, name, created_at, updated_at)
          values (${cardId}, ${FIXTURE_STREAMER_ID}, ${'fixture-card-' + cardId}, ${FIXTURE_TS}, ${FIXTURE_TS})`
      }
    }

    async function clearFixture(sql: Sql) {
      await sql`delete from cards where streamer_id = ${FIXTURE_STREAMER_ID}`
      await sql`delete from users where id = ${FIXTURE_USER_ID}`
      await sql`delete from streamers where id = ${FIXTURE_STREAMER_ID}`
    }

    beforeAll(async () => {
      await seedFixture(sourceSql)
      await seedFixture(targetSql)
    }, 30000)

    afterAll(async () => {
      await clearFixture(sourceSql)
      await clearFixture(targetSql)
    }, 30000)

    it('sanity: 同一にseedしたstreamers/users/cardsはchecksumが一致する（5行・chunkSize=2で3chunk）', async () => {
      const result = await runDataLayer({ sourceSql, targetSql, chunkSize: 2 })
      const byName = Object.fromEntries(result.tables.map((t) => [t.table, t]))
      expect(byName.streamers.checksumMatch).toBe(true)
      expect(byName.users.checksumMatch).toBe(true)
      expect(byName.cards.rowCountMatch).toBe(true)
      expect(byName.cards.checksumMatch).toBe(true)
      expect(byName.cards.source).toBeDefined()
      expect(byName.cards.source?.chunkCount).toBe(3)
      expect(byName.cards.source?.rowCount).toBe(5)
    })

    it('secret列（twitch_access_token）の生値がreportに出ない', async () => {
      const result = await runDataLayer({ sourceSql, targetSql, chunkSize: 2 })
      expect(JSON.stringify(result)).not.toContain(FIXTURE_SECRET_TOKEN)
    })

    it('故障注入5: target側の1行を書き換えると DATA_CHECKSUM_MISMATCH で該当chunkのみ検出する（同件数だが異なるrow）', async () => {
      const mutatedCardId = FIXTURE_CARD_IDS[2]
      await targetSql`update cards set name = 'MUTATED' where id = ${mutatedCardId}`
      try {
        const result = await runDataLayer({ sourceSql, targetSql, chunkSize: 2 })
        const cardsResult = result.tables.find((t) => t.table === 'cards')
        expect(cardsResult).toBeDefined()
        expect(cardsResult?.rowCountMatch).toBe(true)
        expect(cardsResult?.checksumMatch).toBe(false)
        // FIXTURE_CARD_IDS[2]（PK昇順で3番目、0-indexed position 2）はchunkSize=2の下で
        // chunk index 1（0-indexedで2,3番目の行）に属する。
        expect(cardsResult?.mismatchedChunks).toEqual([expect.objectContaining({ chunkIndex: 1 })])
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'DATA_CHECKSUM_MISMATCH', message: expect.stringContaining('cards') })])
        )
      } finally {
        // Issue #697 Chunk 3実装時に発見・修正した既存バグ: `cards`には
        // `update_cards_updated_at`トリガー（00001、BEFORE UPDATE）があり、
        // UPDATE文で指定した値に関わらず`updated_at`を常にNOW()へ強制的に上書きする。
        // 単純に`name`だけを元に戻すUPDATEでは、このtrigger発火により`updated_at`が
        // テスト実行時刻へ書き換わったまま残ってしまい（`name`は復元されるがtimestampは
        // 復元されない）、後続の他テスト（同一fixtureのchecksum比較を前提とするテスト）が
        // 「target側のcardsだけupdated_atが変わっている」という偽の差分を検出してしまう
        // （本ファイルを跨いだ実行順序依存のバグで、単体では気づきにくい）。
        // `session_replication_role = replica`（このファイル内の故障注入7と同じ技法、
        // Issue #697 Chunk 3 invariants layerテストで導入）でBEFORE UPDATEトリガーを
        // 一時的に無効化し、name/updated_at双方を元のfixture値へ厳密に復元する。
        await targetSql.begin(async (tx) => {
          await tx.unsafe('SET LOCAL session_replication_role = replica')
          await tx`update cards set name = ${'fixture-card-' + mutatedCardId}, updated_at = ${FIXTURE_TS} where id = ${mutatedCardId}`
        })
      }
    })

    it('故障注入6: target側の1行を削除すると DATA_ROW_COUNT_MISMATCH になる', async () => {
      const deletedCardId = FIXTURE_CARD_IDS[4]
      await targetSql`delete from cards where id = ${deletedCardId}`
      try {
        const result = await runDataLayer({ sourceSql, targetSql, chunkSize: 2 })
        const cardsResult = result.tables.find((t) => t.table === 'cards')
        expect(cardsResult).toBeDefined()
        expect(cardsResult?.rowCountMatch).toBe(false)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'DATA_ROW_COUNT_MISMATCH', message: expect.stringContaining('cards') })])
        )
      } finally {
        await targetSql`insert into cards (id, streamer_id, name, created_at, updated_at)
          values (${deletedCardId}, ${FIXTURE_STREAMER_ID}, ${'fixture-card-' + deletedCardId}, ${FIXTURE_TS}, ${FIXTURE_TS})`
      }
    })

    it('E2E: verify.mjs CLIで --layers=identity,schema,data --chunk-size=2 を指定すると data layer もJSON reportへ反映される', async () => {
      const result = runNodeScript(
        'scripts/db-cutover/verify.mjs',
        [
          '--source-environment=preview',
          '--source-provider=supabase',
          '--target-environment=preview',
          '--target-provider=planetscale',
          '--layers=identity,schema,data',
          '--chunk-size=2',
        ],
        {
          SOURCE_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
          TARGET_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
          PG_DUMP_BIN: pgDumpBin as string,
        }
      )
      const report = JSON.parse(result.stdout)
      expect(report.layers.data).toBeDefined()
      expect(report.layers.data.chunkSize).toBe(2)
      const cardsResult = report.layers.data.tables.find((t: { table: string }) => t.table === 'cards')
      expect(cardsResult.rowCountMatch).toBe(true)
      expect(cardsResult.checksumMatch).toBe(true)
      // secret redaction: パスワード・secret列の生値がいずれも出力されていないこと。
      expect(result.stdout).not.toContain(POSTGRES_PASSWORD)
      expect(result.stdout).not.toContain(FIXTURE_SECRET_TOKEN)
      expect(result.stderr).not.toContain(POSTGRES_PASSWORD)
    }, 30000)
  })

  describe('invariants layer（Issue #697 Chunk 3、Layer 5 業務invariant）', () => {
    // このdescribeブロックは「data layer」ブロックの後に実行される（vitestはファイル内の
    // describe/itを宣言順に実行する）。data layerブロックのafterAllが自身のfixtureを
    // 掃除済みのため、ここに到達した時点でstreamers/users/cards/gacha_history等は
    // 空の状態（bootstrap.sql・public-schema.sqlはスキーマのみでデータをCOPYしない）。
    // 各itは自分のfixtureを自分でseed/後始末する（他のテストへ影響を持ち越さない）。
    const sourceUrl = () => `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`
    const targetUrl = () => `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`
    const runInvariants = () => runInvariantsLayer({ sourceSql, targetSql, sourceUrl: sourceUrl(), targetUrl: targetUrl() })

    // 00002_add_battle_features.sql のDDLを模した最小限のテーブル（各テストが自分で
    // CREATE/DROPする）。#625により本番相当のbootstrap/public-schema.sqlにはbattles/
    // battle_statsが含まれないため、「テーブルが存在する場合」を検証するにはここで
    // 明示的に作る必要がある（故障注入14/15で共有するため定数化）。
    const BATTLES_DDL = `CREATE TABLE battles (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_card_id UUID NOT NULL REFERENCES user_cards(id) ON DELETE CASCADE,
      opponent_card_id UUID REFERENCES cards(id) ON DELETE CASCADE,
      opponent_card_data JSONB,
      result TEXT NOT NULL CHECK (result IN ('win', 'lose', 'draw')),
      turn_count INTEGER DEFAULT 0,
      battle_log JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`
    const BATTLE_STATS_DDL = `CREATE TABLE battle_stats (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      total_battles INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      win_rate DECIMAL(5, 2) DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`

    it('sanity: 空のsource/targetではinvariants layer全体がpassし、battle-stats-consistencyはallowlistによりinfo+skipされる（#625、故障注入なしでも常に成立する既定状態）', async () => {
      const result = await runInvariants()
      expect(result.pass).toBe(true)
      const battleInv = result.invariants.find((i: { id: string }) => i.id === 'battle-stats-consistency')
      expect(battleInv).toEqual(expect.objectContaining({ allowlisted: true, pass: true, checks: [] }))
      expect(result.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'INVARIANT_REQUIRED_TABLE_MISSING', severity: 'info', allowlisted: true })])
      )
    }, 30000)

    it('故障注入7: user_cards.user_idのFK orphan行（session_replication_role=replicaで意図的に生成）はORPHAN_USER_CARDS_USER_IDをTier Aでfailさせる（source側のみ）', async () => {
      const streamerId = '88888888-8888-8888-8888-888888880001'
      const userId = '88888888-8888-8888-8888-888888880002'
      const cardId = '88888888-8888-8888-8888-888888880003'
      const userCardId = '88888888-8888-8888-8888-888888880004'
      await sourceSql`insert into streamers (id, twitch_user_id, twitch_username, twitch_display_name) values (${streamerId}, 'inv-orphan-streamer', 'invorphan', 'InvOrphan')`
      await sourceSql`insert into cards (id, streamer_id, name) values (${cardId}, ${streamerId}, 'orphan-test-card')`
      await sourceSql`insert into users (id, twitch_user_id, twitch_username, twitch_display_name) values (${userId}, 'inv-orphan-user', 'orphanuser', 'OrphanUser')`
      await sourceSql`insert into user_cards (id, user_id, card_id) values (${userCardId}, ${userId}, ${cardId})`
      try {
        // 実運用ではON DELETE CASCADEのFK制約が常にorphanの発生を防ぐため、この検証は
        // 「制約が万一機能しなかった場合（restore破損等）」を模擬する必要がある。
        // session_replication_role=replica はFK制約を実装する内部トリガー（CASCADE含む）を
        // 一時的に無効化する標準的な手法（pg_restoreのデータロード等でも使われる）。
        // SET LOCALのためトランザクション終了時に自動的に既定値へ戻る。
        await sourceSql.begin(async (tx) => {
          await tx.unsafe('SET LOCAL session_replication_role = replica')
          await tx`delete from users where id = ${userId}`
        })

        const result = await runInvariants()
        expect(result.pass).toBe(false)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ severity: 'fail', code: 'ORPHAN_USER_CARDS_USER_ID', side: 'source' })])
        )
        const inv = result.invariants.find((i: { id: string }) => i.id === 'orphan-foreign-keys')
        const check = inv?.checks.find((c: { code: string }) => c.code === 'ORPHAN_USER_CARDS_USER_ID')
        expect(check?.sideResults.source.violationCount).toBe(1)
        expect(check?.sideResults.source.samples).toEqual([userCardId])
        expect(check?.sideResults.target.violationCount).toBe(0)
      } finally {
        await sourceSql`delete from user_cards where id = ${userCardId}`
        await sourceSql`delete from cards where id = ${cardId}`
        await sourceSql`delete from streamers where id = ${streamerId}`
      }
    }, 30000)

    it('故障注入8: 通常のuser削除（CASCADE経由）でcard_owner_statsに孤児行が残る既知の挙動が両側で一致すればCARD_OWNER_STATS_ORPHAN_USERはseverity=infoでpassする', async () => {
      const streamerId = '88888888-8888-8888-8888-888888880011'
      const cardId = '88888888-8888-8888-8888-888888880012'
      const userId = '88888888-8888-8888-8888-888888880013'
      for (const sql of [sourceSql, targetSql]) {
        await sql`insert into streamers (id, twitch_user_id, twitch_username, twitch_display_name) values (${streamerId}, 'inv-cos-streamer', 'invcos', 'InvCos')`
        await sql`insert into cards (id, streamer_id, name) values (${cardId}, ${streamerId}, 'cos-test-card')`
        await sql`insert into users (id, twitch_user_id, twitch_username, twitch_display_name) values (${userId}, 'inv-cos-user', 'cosuser', 'CosUser')`
        // sync_card_owner_stat トリガー（AFTER INSERT）がcard_owner_statsへ1行作る。
        await sql`insert into user_cards (user_id, card_id) values (${userId}, ${cardId})`
        // 正規のCASCADE削除（00051マイグレーションのコメントに明記された既知の制約）:
        // user_cardsはON DELETE CASCADEで消えるが、その時点でusers行も消えているため
        // sync_card_owner_statトリガーがtwitch_user_idを解決できず、card_owner_statsに
        // 孤児行が残る。バイパス無しの通常のDELETEで再現できる。
        await sql`delete from users where id = ${userId}`
      }
      try {
        const result = await runInvariants()
        const inv = result.invariants.find((i: { id: string }) => i.id === 'card-owner-stats-recalc')
        const check = inv?.checks.find((c: { code: string }) => c.code === 'CARD_OWNER_STATS_ORPHAN_USER')
        expect(check?.sideResults.source.violationCount).toBe(1)
        expect(check?.sideResults.target.violationCount).toBe(1)
        expect(check?.crossCheck?.equal).toBe(true)
        expect(check?.pass).toBe(true)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'CARD_OWNER_STATS_ORPHAN_USER', severity: 'info' })])
        )
      } finally {
        for (const sql of [sourceSql, targetSql]) {
          await sql`delete from card_owner_stats where streamer_id = ${streamerId}`
          await sql`delete from cards where id = ${cardId}`
          await sql`delete from streamers where id = ${streamerId}`
        }
      }
    }, 30000)

    it('故障注入9: 管理UIの汎用PATCH相当（status直接UPDATE）でrevoked済みsupport_codeにuser_licensesが残ると SUPPORT_CODE_REVOKED_LICENSE_RESIDUAL がfailする', async () => {
      const codeId = '88888888-8888-8888-8888-888888880021'
      const licenseId = '88888888-8888-8888-8888-888888880022'
      await sourceSql`insert into support_codes (id, code_hash, plan_type, status) values (${codeId}, 'inv-test-code-hash-1', 'support', 'active')`
      await sourceSql`insert into user_licenses (id, twitch_user_id, code_id, plan_type) values (${licenseId}, 'inv-license-user', ${codeId}, 'support')`
      // revoke_support_code RPC を経由せず、statusのみ直接UPDATEする
      // （analysis/dev/localAdminApi.tsの汎用PATCHが行う操作を模す。ライセンスは削除されない）。
      await sourceSql`update support_codes set status = 'revoked' where id = ${codeId}`
      try {
        const result = await runInvariants()
        expect(result.pass).toBe(false)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ severity: 'fail', code: 'SUPPORT_CODE_REVOKED_LICENSE_RESIDUAL', side: 'source' })])
        )
      } finally {
        await sourceSql`delete from user_licenses where id = ${licenseId}`
        await sourceSql`delete from support_codes where id = ${codeId}`
      }
    }, 30000)

    it('故障注入10: storage_usageの値driftが両側一致すればSTORAGE_USAGE_PER_USER_MISMATCHはseverity=infoでpassする', async () => {
      const userPrefix = 'invtst01'
      for (const sql of [sourceSql, targetSql]) {
        // blob_filesに対応行が無いまま正の値が残っている状態（RPC失敗の黙殺等を模す）。
        await sql`insert into storage_usage (user_prefix, bytes_used, blob_count) values (${userPrefix}, 500, 2)`
      }
      try {
        const result = await runInvariants()
        const inv = result.invariants.find((i: { id: string }) => i.id === 'storage-usage-integrity')
        const check = inv?.checks.find((c: { code: string }) => c.code === 'STORAGE_USAGE_PER_USER_MISMATCH')
        expect(check?.sideResults.source.violationCount).toBe(1)
        expect(check?.crossCheck?.equal).toBe(true)
        expect(check?.pass).toBe(true)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'STORAGE_USAGE_PER_USER_MISMATCH', severity: 'info' })])
        )
      } finally {
        for (const sql of [sourceSql, targetSql]) await sql`delete from storage_usage where user_prefix = ${userPrefix}`
      }
    }, 30000)

    it('故障注入11: driftを持つuser_prefixの集合自体がtarget側だけ異なるとSTORAGE_USAGE_PER_USER_MISMATCHがfailする', async () => {
      // Tier Bのdigestは「違反識別子（user_prefix）の集合」に対して計算する（設計書どおり、
      // 値そのものは含めない）。そのため同じuser_prefixに対して両側とも違反しているが
      // 値の大小だけが違う、というケースは「識別子集合としては一致」＝infoになる
      // （故障注入10のシナリオ）。片側failを正しく再現するには、違反する識別子の集合自体を
      // 非対称にする必要がある: target側にのみdriftを持つ行を追加する（source側は
      // このuser_prefixについて無違反のまま）。
      const userPrefix = 'invtst02'
      await targetSql`insert into storage_usage (user_prefix, bytes_used, blob_count) values (${userPrefix}, 999, 3)`
      try {
        const result = await runInvariants()
        expect(result.pass).toBe(false)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ severity: 'fail', code: 'STORAGE_USAGE_PER_USER_MISMATCH', side: 'both' })])
        )
        const inv = result.invariants.find((i: { id: string }) => i.id === 'storage-usage-integrity')
        const check = inv?.checks.find((c: { code: string }) => c.code === 'STORAGE_USAGE_PER_USER_MISMATCH')
        expect(check?.sideResults.source.violationCount).toBe(0)
        expect(check?.sideResults.target.violationCount).toBe(1)
      } finally {
        await targetSql`delete from storage_usage where user_prefix = ${userPrefix}`
      }
    }, 30000)

    it('故障注入12: N連event_idのサフィックス歯抜け（DELETE /api/gacha-history/[id]相当の単一行削除で発生）が両側一致すればNREN_EVENT_ID_PREFIX_GAPはseverity=infoでpassする', async () => {
      const streamerId = '88888888-8888-8888-8888-888888880031'
      const cardId = '88888888-8888-8888-8888-888888880032'
      const messageId = '77777777-7777-7777-7777-777777770001'
      for (const sql of [sourceSql, targetSql]) {
        await sql`insert into streamers (id, twitch_user_id, twitch_username, twitch_display_name) values (${streamerId}, 'inv-nren-streamer', 'invnren', 'InvNren')`
        await sql`insert into cards (id, streamer_id, name) values (${cardId}, ${streamerId}, 'nren-test-card')`
        // base(1枚目) + :2 + :4（:3が歯抜け）。「途中打ち切り」ではなく明確な中抜けにする。
        await sql`insert into gacha_history (event_id, user_twitch_id, card_id, streamer_id) values (${messageId}, 'inv-nren-user', ${cardId}, ${streamerId})`
        await sql`insert into gacha_history (event_id, user_twitch_id, card_id, streamer_id) values (${messageId + ':2'}, 'inv-nren-user', ${cardId}, ${streamerId})`
        await sql`insert into gacha_history (event_id, user_twitch_id, card_id, streamer_id) values (${messageId + ':4'}, 'inv-nren-user', ${cardId}, ${streamerId})`
      }
      try {
        const result = await runInvariants()
        const inv = result.invariants.find((i: { id: string }) => i.id === 'nren-event-id-prefix')
        const check = inv?.checks.find((c: { code: string }) => c.code === 'NREN_EVENT_ID_PREFIX_GAP')
        expect(check?.sideResults.source.violationCount).toBe(1)
        expect(check?.sideResults.source.samples).toEqual([messageId])
        expect(check?.crossCheck?.equal).toBe(true)
        expect(check?.pass).toBe(true)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'NREN_EVENT_ID_PREFIX_GAP', severity: 'info' })])
        )
      } finally {
        for (const sql of [sourceSql, targetSql]) {
          await sql`delete from gacha_history where streamer_id = ${streamerId}`
          await sql`delete from cards where id = ${cardId}`
          await sql`delete from streamers where id = ${streamerId}`
        }
      }
    }, 30000)

    it('故障注入13: N連歯抜けがtarget側にのみ存在するとNREN_EVENT_ID_PREFIX_GAPがfailする（片側のみの違反は正規操作起因でも許容しない）', async () => {
      const streamerId = '88888888-8888-8888-8888-888888880041'
      const cardId = '88888888-8888-8888-8888-888888880042'
      const messageId = '77777777-7777-7777-7777-777777770002'
      for (const sql of [sourceSql, targetSql]) {
        await sql`insert into streamers (id, twitch_user_id, twitch_username, twitch_display_name) values (${streamerId}, 'inv-nren2-streamer', 'invnren2', 'InvNren2')`
        await sql`insert into cards (id, streamer_id, name) values (${cardId}, ${streamerId}, 'nren2-test-card')`
        await sql`insert into gacha_history (event_id, user_twitch_id, card_id, streamer_id) values (${messageId}, 'inv-nren2-user', ${cardId}, ${streamerId})`
        await sql`insert into gacha_history (event_id, user_twitch_id, card_id, streamer_id) values (${messageId + ':2'}, 'inv-nren2-user', ${cardId}, ${streamerId})`
      }
      // target側のみ :4 を追加（歯抜け発生）。sourceはbase+:2のみで途中打ち切り＝正常。
      await targetSql`insert into gacha_history (event_id, user_twitch_id, card_id, streamer_id) values (${messageId + ':4'}, 'inv-nren2-user', ${cardId}, ${streamerId})`
      try {
        const result = await runInvariants()
        expect(result.pass).toBe(false)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ severity: 'fail', code: 'NREN_EVENT_ID_PREFIX_GAP', side: 'both' })])
        )
        const inv = result.invariants.find((i: { id: string }) => i.id === 'nren-event-id-prefix')
        const check = inv?.checks.find((c: { code: string }) => c.code === 'NREN_EVENT_ID_PREFIX_GAP')
        expect(check?.sideResults.source.violationCount).toBe(0)
        expect(check?.sideResults.target.violationCount).toBe(1)
      } finally {
        for (const sql of [sourceSql, targetSql]) {
          await sql`delete from gacha_history where streamer_id = ${streamerId}`
          await sql`delete from cards where id = ${cardId}`
          await sql`delete from streamers where id = ${streamerId}`
        }
      }
    }, 30000)

    it('故障注入14: battles/battle_statsが存在する環境（プレビュー想定）ではallowlistが適用されず、battle_statsの行内不整合をBATTLE_STATS_ROW_INCONSISTENTがTier Aでfailする', async () => {
      const userId = '88888888-8888-8888-8888-888888880051'
      const battleStatsId = '88888888-8888-8888-8888-888888880052'
      for (const sql of [sourceSql, targetSql]) {
        await sql.unsafe(BATTLES_DDL)
        await sql.unsafe(BATTLE_STATS_DDL)
        await sql`insert into users (id, twitch_user_id, twitch_username, twitch_display_name) values (${userId}, 'inv-battle-user', 'battleuser', 'BattleUser')`
        // wins(1) + losses(1) + draws(1) = 3 だが total_battles=5 で不整合。
        await sql`insert into battle_stats (id, user_id, total_battles, wins, losses, draws, win_rate) values (${battleStatsId}, ${userId}, 5, 1, 1, 1, 20.00)`
      }
      try {
        const result = await runInvariants()
        expect(result.pass).toBe(false)
        const inv = result.invariants.find((i: { id: string }) => i.id === 'battle-stats-consistency')
        expect(inv?.allowlisted).toBe(false)
        const check = inv?.checks.find((c: { code: string }) => c.code === 'BATTLE_STATS_ROW_INCONSISTENT')
        expect(check?.pass).toBe(false)
        expect(check?.sideResults.source.violationCount).toBe(1)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ severity: 'fail', code: 'BATTLE_STATS_ROW_INCONSISTENT', side: 'source' })])
        )
      } finally {
        for (const sql of [sourceSql, targetSql]) {
          await sql.unsafe('DROP TABLE IF EXISTS battles')
          await sql.unsafe('DROP TABLE IF EXISTS battle_stats')
          await sql`delete from users where id = ${userId}`
        }
      }
    }, 30000)

    it('故障注入15: total_battlesとcountersが両方NULLのbattle_stats行はBATTLE_STATS_ROW_INCONSISTENTでfailする（オーケストレーターレビュー Minor-1対応、PG17実測で再現確認済みの偽陰性の回帰防止）', async () => {
      const userId = '88888888-8888-8888-8888-888888880061'
      const battleStatsId = '88888888-8888-8888-8888-888888880062'
      for (const sql of [sourceSql, targetSql]) {
        await sql.unsafe(BATTLES_DDL)
        await sql.unsafe(BATTLE_STATS_DDL)
        await sql`insert into users (id, twitch_user_id, twitch_username, twitch_display_name) values (${userId}, 'inv-battle-null-user', 'battlenulluser', 'BattleNullUser')`
        // total_battles=NULL かつ wins=NULLだがlosses/draws=0という、修正前は
        // 3条件（sum IS DISTINCT FROM/0除算ガード付きwin_rate/total=0別条件）の
        // いずれもすり抜けていた組み合わせ。修正後は`total_battles IS NULL`の
        // 独立条件で必ず検出される。
        await sql`insert into battle_stats (id, user_id, total_battles, wins, losses, draws, win_rate) values (${battleStatsId}, ${userId}, null, null, 0, 0, 0)`
      }
      try {
        const result = await runInvariants()
        expect(result.pass).toBe(false)
        const inv = result.invariants.find((i: { id: string }) => i.id === 'battle-stats-consistency')
        const check = inv?.checks.find((c: { code: string }) => c.code === 'BATTLE_STATS_ROW_INCONSISTENT')
        expect(check?.pass).toBe(false)
        expect(check?.sideResults.source.violationCount).toBe(1)
        expect(check?.sideResults.target.violationCount).toBe(1)
        expect(result.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ severity: 'fail', code: 'BATTLE_STATS_ROW_INCONSISTENT' })])
        )
      } finally {
        for (const sql of [sourceSql, targetSql]) {
          await sql.unsafe('DROP TABLE IF EXISTS battles')
          await sql.unsafe('DROP TABLE IF EXISTS battle_stats')
          await sql`delete from users where id = ${userId}`
        }
      }
    }, 30000)

    it('E2E: verify.mjs CLIで --layers=identity,schema,data,invariants を指定すると invariants layer もJSON reportへ反映され、クリーンな状態ではdecision=passになる', async () => {
      const result = runNodeScript(
        'scripts/db-cutover/verify.mjs',
        [
          '--source-environment=preview',
          '--source-provider=supabase',
          '--target-environment=preview',
          '--target-provider=planetscale',
          '--layers=identity,schema,data,invariants',
        ],
        {
          SOURCE_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
          TARGET_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
          PG_DUMP_BIN: pgDumpBin as string,
        }
      )
      const report = JSON.parse(result.stdout)
      expect(report.layers.invariants).toBeDefined()
      expect(report.layers.invariants.pass).toBe(true)
      expect(report.layers.invariants.invariants.length).toBeGreaterThan(0)
      const battleInv = report.layers.invariants.invariants.find((i: { id: string }) => i.id === 'battle-stats-consistency')
      expect(battleInv.allowlisted).toBe(true)
      expect(report.decision).toBe('pass')
      expect(result.status).toBe(0)
      // secret redaction: パスワードが生値で出力されていないこと。
      expect(result.stdout).not.toContain(POSTGRES_PASSWORD)
      expect(result.stderr).not.toContain(POSTGRES_PASSWORD)
    }, 30000)
  })

  describe('canary layer（Issue #697 Chunk 4、Layer 6 runtime canary）', () => {
    // このdescribeブロックは invariants layer ブロックの後に実行される。canaryはtarget側
    // のみを対象とするため（ファイル冒頭のlayer-canary.mjs設計コメント参照）、各itは
    // targetSqlのみを使う。fixtureはrunCanaryLayer自身が生成・後始末する（常にROLLBACKする
    // 設計、withRollbackOnlyTransaction参照）ため、通常は明示的なfixture後始末が不要だが、
    // 「事前に衝突行を置く」「トリガーを無効化する」等の故障注入部分は各itが自分で後始末する。
    const targetUrl = () => `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`

    it('故障注入(canary)16: 成功パスE2E（fixture→RPC→トリガー発火→rollback→痕跡ゼロ）。6チェック全passかつrollback後に一切の痕跡が残らないことは、withRollbackOnlyTransactionが一度もCOMMITしていないことの動作証跡（commit禁止guardの構造検証を兼ねる）', async () => {
      const runId = 'canary-e2e-success-test'
      const identifiers = buildFixtureIdentifiers(runId)
      const result = await runCanaryLayer({ targetSql, targetUrl: targetUrl(), runId })

      expect(result.pass).toBe(true)
      expect(result.checks).toHaveLength(6)
      for (const check of result.checks) {
        expect(check.pass).toBe(true)
        expect(check.skipped).toBe(false)
        expect(check.findings).toEqual([])
      }

      // rollback後、トランザクション外から見て一切の痕跡が無いこと。canary-rollback-verification
      // 自身の自己検証結果（上記check.pass===true）に加え、テスト側からも独立に再確認する
      // （ツール自身の自己申告だけに頼らない）。集計トリガーが作ったchannel_point_usage_stats/
      // card_owner_statsも合わせて確認する（設計書の必須確認対象4テーブルには無いが、
      // ON DELETE CASCADEの範囲外でもrollback自体で当然消えているはずのため、より広い網で確認）。
      const streamerRows = await targetSql`select id from streamers where twitch_user_id = ${identifiers.streamerTwitchUserId}`
      const userRows = await targetSql`select id from users where twitch_user_id = ${identifiers.userTwitchUserId}`
      const historyRows = await targetSql`select id from gacha_history where event_id = ${identifiers.eventId}`
      const cpuRows = await targetSql`select 1 as x from channel_point_usage_stats where user_twitch_id = ${identifiers.userTwitchUserId}`
      const cosRows = await targetSql`select 1 as x from card_owner_stats where user_twitch_id = ${identifiers.userTwitchUserId}`
      expect(streamerRows).toHaveLength(0)
      expect(userRows).toHaveLength(0)
      expect(historyRows).toHaveLength(0)
      expect(cpuRows).toHaveLength(0)
      expect(cosRows).toHaveLength(0)
    }, 30000)

    it('故障注入(canary)17: fixture衝突（既存行と同一twitch_user_idを事前に置いた場合）。fixtureセットアップがUNIQUE制約違反でfailし、依存する3チェックがskipされ、canary-gacha-rpcにCANARY_FIXTURE_SETUP_ERRORが1件だけ計上される', async () => {
      const runId = 'canary-collision-test'
      const identifiers = buildFixtureIdentifiers(runId)
      // 過去のcanary実行の残骸、または偶発的な衝突を模して、事前に同一twitch_user_idの
      // streamers行を置いておく。
      await targetSql`insert into streamers (twitch_user_id, twitch_username, twitch_display_name) values (${identifiers.streamerTwitchUserId}, 'collision', 'Collision')`
      try {
        const result = await runCanaryLayer({ targetSql, targetUrl: targetUrl(), runId })
        expect(result.pass).toBe(false)

        const gachaRpcCheck = result.checks.find((c: { id: string }) => c.id === 'canary-gacha-rpc')
        expect(gachaRpcCheck?.skipped).toBe(true)
        expect(gachaRpcCheck?.findings).toEqual([expect.objectContaining({ severity: 'fail', code: 'CANARY_FIXTURE_SETUP_ERROR' })])

        for (const id of ['canary-updated-at-trigger', 'canary-timestamp-shape', 'canary-jsonb-array-parse']) {
          const check = result.checks.find((c: { id: string }) => c.id === id)
          expect(check?.skipped).toBe(true)
          expect(check?.findings).toEqual([])
        }

        // dashboard-readsとrollback-verificationはfixtureセットアップに依存しないため
        // 通常どおり実行される（skipped:false）。
        expect(result.checks.find((c: { id: string }) => c.id === 'canary-dashboard-reads')?.skipped).toBe(false)
        expect(result.checks.find((c: { id: string }) => c.id === 'canary-rollback-verification')?.skipped).toBe(false)
      } finally {
        await targetSql`delete from streamers where twitch_user_id = ${identifiers.streamerTwitchUserId}`
      }
    }, 30000)

    it('故障注入(canary)18: トリガー無効化fail検出。trg_sync_channel_point_usage_statを無効化するとcanary-gacha-rpcがCANARY_GACHA_RPC_TRIGGER_CHANNEL_POINT_USAGE_MISSINGでfailする', async () => {
      await targetSql.unsafe('ALTER TABLE gacha_history DISABLE TRIGGER trg_sync_channel_point_usage_stat')
      try {
        const runId = 'canary-trigger-disabled-test'
        const result = await runCanaryLayer({ targetSql, targetUrl: targetUrl(), runId })
        expect(result.pass).toBe(false)
        const gachaRpcCheck = result.checks.find((c: { id: string }) => c.id === 'canary-gacha-rpc')
        expect(gachaRpcCheck?.pass).toBe(false)
        expect(gachaRpcCheck?.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ severity: 'fail', code: 'CANARY_GACHA_RPC_TRIGGER_CHANNEL_POINT_USAGE_MISSING' })])
        )
        // このトランザクションも最終的にROLLBACKされるため、無効化の影響は他のitへ持ち越されない
        // （withRollbackOnlyTransactionはtrigger無効化自体をrollbackしない。DISABLE TRIGGERは
        // DDLでトランザクショナルだが、本testはトランザクション**外**でALTER TABLEしているため、
        // 明示的なfinally句での復旧が必須）。
      } finally {
        await targetSql.unsafe('ALTER TABLE gacha_history ENABLE TRIGGER trg_sync_channel_point_usage_stat')
      }
    }, 30000)

    it('故障注入(canary)19: is_active=falseのcardに execute_gacha_transaction を直接呼ぶと limit_reached:true を返す（canaryのfixtureがis_active=true固定にしている設計判断の裏取り。checkGachaRpcはis_active=true前提でlimit_reached:falseを期待するため、この分岐に入ると正しくfailを報告できることの根拠）', async () => {
      const streamerId = '66666666-6666-6666-6666-666666660001'
      const cardId = '66666666-6666-6666-6666-666666660002'
      const eventId = 'canary-test-inactive-card-event'
      const userTwitchId = 'canary-inactive-test-user'
      await targetSql`insert into streamers (id, twitch_user_id, twitch_username, twitch_display_name) values (${streamerId}, 'canary-inactive-streamer', 'canaryinactive', 'CanaryInactive')`
      await targetSql`insert into cards (id, streamer_id, name, is_active) values (${cardId}, ${streamerId}, 'inactive-card', false)`
      try {
        const rows = await targetSql`
          select execute_gacha_transaction(
            p_event_id => ${eventId},
            p_user_twitch_id => ${userTwitchId},
            p_user_twitch_username => ${'CanaryInactiveTestUser'},
            p_card_id => ${cardId}::uuid,
            p_streamer_id => ${streamerId}::uuid,
            p_reward_cost => ${100}::integer,
            p_reward_id => ${null}
          ) as result
        `
        expect(rows[0].result).toEqual({ is_duplicate: false, limit_reached: true })
      } finally {
        await targetSql`delete from gacha_history where event_id = ${eventId}`
        await targetSql`delete from cards where id = ${cardId}`
        await targetSql`delete from streamers where id = ${streamerId}`
        await targetSql`delete from users where twitch_user_id = ${userTwitchId}`
      }
    }, 30000)

    it('故障注入(canary)20: SAVEPOINT隔離の実機検証。canary-updated-at-triggerのUPDATEのみをCHECK制約で意図的にabort(25P02)させ、当該チェックのみfail・他5チェックは正常継続・最終rollbackで痕跡ゼロを同時に確認する', async () => {
      // streamers.twitch_display_nameに対するCHECK制約: checkUpdatedAtTriggerが使う
      // UPDATE文の新しい値（'Cutover Canary (updated)'）だけを拒否する。fixtureセットアップの
      // INSERT時点の値（'Cutover Canary'）や他チェックの操作（gacha-rpcのINSERT・
      // jsonb-array-parseのusers UPDATE・dashboard-readsのSELECT）とは無関係のため、
      // canary-updated-at-trigger以外への副作用が無い、意図的に狙い撃ちした故障注入。
      await targetSql.unsafe(
        `ALTER TABLE streamers ADD CONSTRAINT test_block_canary_update CHECK (twitch_display_name <> 'Cutover Canary (updated)')`
      )
      try {
        const runId = 'canary-savepoint-isolation-test'
        const identifiers = buildFixtureIdentifiers(runId)
        const result = await runCanaryLayer({ targetSql, targetUrl: targetUrl(), runId })

        expect(result.pass).toBe(false)

        const updatedAtCheck = result.checks.find((c: { id: string }) => c.id === 'canary-updated-at-trigger')
        expect(updatedAtCheck?.pass).toBe(false)
        expect(updatedAtCheck?.skipped).toBe(false)
        expect(updatedAtCheck?.findings).toEqual([expect.objectContaining({ severity: 'fail', code: 'CANARY_RUNTIME_ERROR' })])

        // SAVEPOINT隔離の核心確認: 他の5チェックはCHECK制約違反によるabort(25P02)の影響を
        // 受けず、正常にpassし続けている。
        const otherChecks = result.checks.filter((c: { id: string }) => c.id !== 'canary-updated-at-trigger')
        expect(otherChecks).toHaveLength(5)
        for (const check of otherChecks) {
          expect(check.pass).toBe(true)
          expect(check.findings).toEqual([])
        }

        // 1チェックのabortがあっても最終的なROLLBACKは正常に完了し、痕跡ゼロであること
        // （updated-at-triggerのエラーでトランザクション全体がabortされたままROLLBACKされずに
        // 残っている、という事態が起きていないことの確認）。
        const streamerRows = await targetSql`select id from streamers where twitch_user_id = ${identifiers.streamerTwitchUserId}`
        expect(streamerRows).toHaveLength(0)
      } finally {
        await targetSql.unsafe('ALTER TABLE streamers DROP CONSTRAINT IF EXISTS test_block_canary_update')
      }
    }, 30000)

    it('E2E(canary)21: identity layerがfailすると後続のcanaryは実行されない（notEvaluated、identityの無条件breakがcanaryも保護することの確認）', async () => {
      const result = runNodeScript(
        'scripts/db-cutover/verify.mjs',
        [
          '--source-environment=preview',
          '--source-provider=supabase',
          // 実際にseedした値（beforeAll参照）は'preview'のため、意図的に'production'を宣言して
          // ENVIRONMENT_MISMATCHでidentity layerをfailさせる。
          '--target-environment=production',
          '--target-provider=planetscale',
          '--operation-id=cutover-identity-fail-canary-test',
          '--layers=identity,canary',
        ],
        {
          SOURCE_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
          TARGET_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
        }
      )
      const report = JSON.parse(result.stdout)
      expect(report.layers.identity.pass).toBe(false)
      expect(report.layers.canary).toEqual({ layer: 'canary', pass: null, findings: [], notEvaluated: true })
      expect(report.decision).toBe('fail')
      expect(result.status).toBe(1)
    }, 30000)

    it('E2E(canary)22: --fail-fast指定時、schema layerがfailすると後続のcanaryは実行されない。--fail-fast無し（既定のfull-report mode）なら同じ状況でもcanaryは実行される', async () => {
      // 故障注入3と同じ手法（target側usersテーブルへの列追加）でschema layerを確実にfailさせる。
      // 2026-07-22注記: 以前はcardsテーブルを使っていたが、cardsは
      // `cutover-allowlist.mjs`のCHECK_CONSTRAINT_DEPARSE_VERSION_DIFFエントリで
      // allowlist化されたため、cardsへの列追加はもはやschema layerをfailさせない
      // （故障注入3の注記・故障注入3-allowlistテスト参照）。本テストはfail-fastの
      // 挙動そのものを検証したいので、allowlist非対象の`users`テーブルへ変更した。
      await targetSql.unsafe('ALTER TABLE public.users ADD COLUMN cutover_test_failfast_column text')
      try {
        const envVars = {
          SOURCE_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SOURCE_PORT}/postgres`,
          TARGET_DATABASE_URL: `postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${TARGET_PORT}/postgres`,
          PG_DUMP_BIN: pgDumpBin as string,
        }
        const baseArgs = [
          '--source-environment=preview',
          '--source-provider=supabase',
          '--target-environment=preview',
          '--target-provider=planetscale',
          '--layers=identity,schema,canary',
        ]

        const withFailFast = runNodeScript('scripts/db-cutover/verify.mjs', [...baseArgs, '--fail-fast'], envVars)
        const failFastReport = JSON.parse(withFailFast.stdout)
        expect(failFastReport.layers.schema.pass).toBe(false)
        expect(failFastReport.layers.canary).toEqual({ layer: 'canary', pass: null, findings: [], notEvaluated: true })

        const withoutFailFast = runNodeScript('scripts/db-cutover/verify.mjs', baseArgs, envVars)
        const fullReport = JSON.parse(withoutFailFast.stdout)
        expect(fullReport.layers.schema.pass).toBe(false)
        // full-report modeではschemaがfailしてもcanaryは実行され、実際の判定結果
        // （notEvaluatedではない、pass: true/falseのいずれか）を持つ。
        expect(fullReport.layers.canary.notEvaluated).toBeUndefined()
        expect(typeof fullReport.layers.canary.pass).toBe('boolean')
      } finally {
        await targetSql.unsafe('ALTER TABLE public.users DROP COLUMN cutover_test_failfast_column')
      }
    }, 60000)
  })
})
