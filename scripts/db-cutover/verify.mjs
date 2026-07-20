#!/usr/bin/env node

/**
 * db:cutover:verify CLI 本体 / Issue #697 Chunk 1
 *
 * source（例: Supabase）と target（例: PlanetScale）を比較し、cutoverのGO/NO-GO判定材料となる
 * JSON report（CutoverVerificationReport、Issue #697本文の型に準拠）を生成する。
 * Chunk 1では identity（Layer 1）・schema（Layer 2）の2 layer のみ実装する。
 *
 * 実行順序について: --layers に identity を含む場合、必ず最初に実行し、failした場合は
 * 後続のlayerを一切実行せず即座に停止する（Issue #697本文「source/target identity
 * mismatchで実行停止」）。schema等のクエリを、同一DBを誤って比較している状態や
 * environment取り違えの状態で実行してしまう事故を防ぐため。
 *
 * 出力: JSON report を標準出力（stdout）へ1回だけ出力する（`> report.json` でそのまま
 * リダイレクト可能にするため、進捗ログは全て console.error/stderr へ出す）。加えて
 * db/planetscale/.artifacts/ 配下（.gitignore 済み）にファイルとしても保存する。
 */

'use strict'

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import postgres from 'postgres'
import { resolveVerifyConfig, HELP_TEXT } from './cli-args.mjs'
import { runIdentityLayer } from './layer-identity.mjs'
import { runSchemaLayer } from './layer-schema.mjs'
import { buildReport } from './report.mjs'

const require = createRequire(import.meta.url)
const core = require('../lib/db-migrate-core.js')

// オーケストレーターレビュー Minor-5対応: 以前は 'db/planetscale/.artifacts' という
// cwd相対パスだった。`npm run db:cutover:verify` 経由（npmがcwdをpackage.jsonのある
// リポジトリルートに固定する）なら実害は無いが、`node scripts/db-cutover/verify.mjs` を
// 別ディレクトリから直接叩いた場合に意図しない場所へ書き込んでしまう。
// import.meta.url からこのファイル自身の場所を起点に、リポジトリルート
// （scripts/db-cutover/ の2階層上）を絶対パスで解決する。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARTIFACT_OUT_DIR = join(REPO_ROOT, 'db', 'planetscale', '.artifacts')

/**
 * report を db/planetscale/.artifacts/ 配下へ保存する。ファイル名は operationId（あれば）と
 * 実行時刻を含み、同一実行の複数回再試行でも上書きせず全件残す（cutover当日の判断材料として
 * 「いつ・何回実行し、それぞれどう判定されたか」を後から追跡できるようにするため）。
 * @param {object} report
 */
function writeReportArtifact(report) {
  mkdirSync(ARTIFACT_OUT_DIR, { recursive: true })
  const safeOperationId = (report.operationId ?? 'adhoc').replace(/[^a-zA-Z0-9_-]/g, '_')
  const filename = `cutover-verify-${safeOperationId}-${Date.now()}.json`
  const outPath = join(ARTIFACT_OUT_DIR, filename)
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  return outPath
}

async function main() {
  const resolved = resolveVerifyConfig(process.argv, process.env)

  if (resolved.help) {
    console.log(HELP_TEXT)
    return 0
  }
  if (resolved.error) {
    console.error(`[cutover-verify] ${resolved.error}`)
    console.error('')
    console.error(HELP_TEXT)
    return 1
  }

  const {
    sourceEnvironment,
    targetEnvironment,
    sourceProvider,
    targetProvider,
    layers,
    operationId,
    sourceUrl,
    targetUrl,
  } = resolved

  // 進捗ログは全てstderrへ（stdoutはJSON report専用。Issue #697本文「machine-readable JSON」の
  // 要求を`> report.json`でそのまま満たせるようにするため）。
  console.error(`[cutover-verify] source=${core.redactConnectionString(sourceUrl)} (environment=${sourceEnvironment} provider=${sourceProvider})`)
  console.error(`[cutover-verify] target=${core.redactConnectionString(targetUrl)} (environment=${targetEnvironment} provider=${targetProvider})`)
  console.error(`[cutover-verify] layers=${layers.join(',')} operationId=${operationId ?? '(none)'}`)

  if (!layers.includes('identity')) {
    console.error(
      '[cutover-verify] 警告: --layers に identity が含まれていません。' +
        'source/targetの取り違え・環境取り違えの検知が行われないまま後続layerを実行します。'
    )
  }

  const sourceSql = postgres(core.stripPostgresJsIncompatibleSslParams(sourceUrl), { max: 1, connect_timeout: 15 })
  const targetSql = postgres(core.stripPostgresJsIncompatibleSslParams(targetUrl), { max: 1, connect_timeout: 15 })

  /** 接続文字列由来の機微情報をエラーメッセージから除去する（source/target両方に対して）。 */
  const redactBoth = (text) => core.redactSecretsFromText(core.redactSecretsFromText(text, sourceUrl), targetUrl)

  const executedLayerResults = []
  let exitCode = 2
  try {
    // M-4（Fableレビュー Major対応）: 以前はlayer実行中の例外がここまで伝播すると
    // 即座にexit 2で終了し、report（stdout・artifactファイルとも）が一切生成されなかった。
    // これは本ファイル冒頭のコメントが掲げる「いつ・何回実行し、それぞれどう判定されたかを
    // 後から追跡できるようにする」という目的、およびcutover当日の監査証跡としての役割と
    // 矛盾する（一時的なネットワーク断等でも記録が丸ごと消える）。
    // layer実行だけをtry/catchで囲み、例外はLAYER_RUNTIME_ERRORというfail findingへ変換して
    // report生成を必ず最後まで到達させる（以降のlayerは安全側で停止する）。
    try {
      for (const layerName of layers) {
        if (layerName === 'identity') {
          const result = await runIdentityLayer({
            sourceSql,
            targetSql,
            expected: { sourceEnvironment, sourceProvider, targetEnvironment, targetProvider },
          })
          executedLayerResults.push(result)
          console.error(`[cutover-verify] layer=identity pass=${result.pass}`)
          if (!result.pass) {
            console.error('[cutover-verify] identity layerがfailしたため、後続layerの実行を停止します。')
            break
          }
        } else if (layerName === 'schema') {
          const result = await runSchemaLayer({
            sourceUrl,
            targetUrl,
            sourceSql,
            targetSql,
            pgDumpBin: process.env.PG_DUMP_BIN,
          })
          executedLayerResults.push(result)
          console.error(`[cutover-verify] layer=schema pass=${result.pass}`)
        }
      }
    } catch (layerError) {
      const message = redactBoth(layerError instanceof Error ? layerError.message : String(layerError))
      console.error(`[cutover-verify] layer実行中に予期しないエラーが発生しました（後続layerは停止します）: ${message}`)
      executedLayerResults.push({
        // 2回目Fableレビュー Minor-3対応（コメント不正確、コード自体は正しかった）:
        // `layers[executedLayerResults.length]` が指すのは「次に実行されるはずだったlayer」
        // ではなく、「例外発生時にまさに実行中だったlayer」そのものである
        // （例: identity実行中に例外→この時点でexecutedLayerResults.lengthは0
        // →layers[0]='identity'。これはpushされる直前の状態なので、例外を投げたlayer自身の
        // インデックスと一致する）。
        layer: layers[executedLayerResults.length] ?? 'unknown',
        pass: false,
        findings: [{ severity: 'fail', code: 'LAYER_RUNTIME_ERROR', message: `layer実行中に予期しないエラーが発生しました: ${message}`, side: 'both' }],
      })
    }

    const report = buildReport({
      operationId,
      generatedAt: new Date().toISOString(),
      sourceExpected: { environment: sourceEnvironment, provider: sourceProvider },
      targetExpected: { environment: targetEnvironment, provider: targetProvider },
      requestedLayers: layers,
      executedLayerResults,
    })

    // Minor-2（Fableレビュー）: artifactファイルへの書き込み（ディスク権限等の理由で失敗しうる）を
    // stdout出力より前に置くと、書き込み失敗時にreportが標準出力にすら出ず全損する。
    // artifact保存はあくまで補助的な永続化であり、stdoutへのJSON出力（呼び出し元が
    // `> report.json` でリダイレクトする主経路）を優先する。書き込み失敗はwarningとして
    // ログするに留め、コマンド自体の成否（exitCode）には影響させない。
    let artifactPath = null
    try {
      artifactPath = writeReportArtifact(report)
    } catch (writeError) {
      // オーケストレーターレビュー Minor-2対応: 他のエラーパスと同様にredactionを通す
      // （fs書き込みエラーが接続文字列を含む可能性は通常無いが、一貫性のため）。
      console.error(`[cutover-verify] 警告: report artifactの書き込みに失敗しました（stdout出力は継続します）: ${redactBoth(writeError instanceof Error ? writeError.message : String(writeError))}`)
    }
    console.error(`[cutover-verify] report artifact: ${artifactPath ?? '(書き込み失敗、上記警告参照)'}`)
    console.error(`[cutover-verify] decision=${report.decision}`)
    console.log(JSON.stringify(report, null, 2))

    // decision='pass' のみ exit 0。'fail'/'not-evaluated' はいずれも「GOと言えない」ため
    // 検証エラー相当の exit 1 とする（db-migrate.js/verify-db-schema.js と同じ終了コード規約:
    // 0=OK, 1=検証エラー, 2=運用エラー）。
    exitCode = report.decision === 'pass' ? 0 : 1
  } catch (error) {
    // ここに到達するのは report の組み立て・artifact書き込み自体が失敗した場合のみ
    // （layer実行の例外は上のtry/catchで既に吸収されている）。この場合のみ真に
    // report を生成できないため、運用エラー（exit 2）として扱う。
    const message = redactBoth(error instanceof Error ? error.message : String(error))
    console.error(`[cutover-verify] 予期しないエラーで終了しました: ${message}`)
    exitCode = 2
  } finally {
    await sourceSql.end({ timeout: 5 })
    await targetSql.end({ timeout: 5 })
  }
  return exitCode
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      // Minor-3（Fableレビュー）: main() 内部の try/catch は resolveVerifyConfig 通過後の
      // 処理のみをカバーする（sourceSql/targetSql の postgres() 呼び出し自体が同期的に
      // 例外を投げるような極端なケースはtryの外）。ここで拾わないとunhandled rejectionとして
      // redaction を経ない生のスタックトレースが出力されうる。SOURCE_DATABASE_URL/
      // TARGET_DATABASE_URL はprocess.envから直接参照できるため、ここでもredactする。
      const message = core.redactSecretsFromText(
        core.redactSecretsFromText(String(error?.stack ?? error), process.env.SOURCE_DATABASE_URL),
        process.env.TARGET_DATABASE_URL
      )
      console.error('[cutover-verify] 予期しない例外で終了しました:', message)
      process.exitCode = 2
    })
}
