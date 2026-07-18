#!/usr/bin/env node

/**
 * Maintenance EventSub replay runner / メンテナンス中に退避されたEventSub通知のリプレイ実行 (#787 Stage 4)
 *
 * 背景:
 * issue #694 で実装した maintenance mode 中のEventSub退避
 * (src/lib/maintenance/eventsub-park.ts の parkEventSubNotification) は、
 * KVへ退避するだけで再処理する仕組みが無かった。issue #787 で
 * src/app/api/admin/eventsub-replay/route.ts を新設し、退避データを
 * バッチ単位で再処理できるようにした。本スクリプトはそのHTTP APIを
 * cursorページネーションで完走させ、結果を人間が読める形で標準出力する
 * CLIラッパーである。
 *
 * scripts/probe-maintenance-write-surfaces.js と同じCLI引数パース・
 * fetch呼び出しの流儀（純粋関数を分離してmodule.exportsする、
 * --helpサポート等）を踏襲する。
 *
 * シークレットについて:
 * X-Replay-Secret ヘッダーに使うシークレットは環境変数 EVENTSUB_REPLAY_SECRET
 * からのみ読む（CLI引数にしない）。CLI引数はシェル履歴やプロセス一覧
 * （`ps aux` 等）に残ってしまうため、シークレットの漏洩経路を最小化する。
 *
 * 使い方:
 *   EVENTSUB_REPLAY_SECRET=<secret> node scripts/replay-maintenance-eventsub.js --url=<base-url>
 *   EVENTSUB_REPLAY_SECRET=<secret> node scripts/replay-maintenance-eventsub.js --url=<base-url> --dry-run
 *   EVENTSUB_REPLAY_SECRET=<secret> node scripts/replay-maintenance-eventsub.js --url=<base-url> --limit=50
 *   npm run replay:maintenance-eventsub -- --url=<base-url>
 *
 * 運用手順の詳細（実行タイミング・前提条件）は docs/db-phase2-runbook.md を参照。
 */

'use strict'

const REPLAY_PATH = '/api/admin/eventsub-replay'

/**
 * fetch 1バッチあたりのタイムアウト（ミリ秒）。対象Workerが無応答の場合に
 * スクリプトがハングし続けるのを防ぐ。
 *
 * 120秒の根拠（中-3）: replay route（src/app/api/admin/eventsub-replay/route.ts）は
 * バッチ内の各エントリを直列処理し、postRedemptionNotify（ガチャRPC + realtime
 * broadcast（失敗時500msリトライ）+ チャット送信 + カウントクエリ）を意図的に
 * 同期awaitする（レスポンスでバッチ完了を正確に報告するため）。1エントリあたり
 * 1〜3秒かかりうるため、既定の --limit（サーバー側 DEFAULT_LIMIT=20、
 * route.ts参照）でも旧30秒では超過が現実的だった。120秒あれば既定値20件は
 * 余裕を持って収まる。ただし --limit を上限の100付近まで大きくすると
 * 100件×最大3秒=300秒のように120秒を超えうるため、大きい --limit を指定する
 * 場合は本数を絞ってバッチを分けるか、この定数を環境に合わせて引き上げること
 * （HELP_TEXT の --limit 説明にも同旨を記載）。
 */
const FETCH_TIMEOUT_MS = 120_000

const HELP_TEXT = `
使い方:
  EVENTSUB_REPLAY_SECRET=<secret> node scripts/replay-maintenance-eventsub.js --url=<対象URL>
  EVENTSUB_REPLAY_SECRET=<secret> node scripts/replay-maintenance-eventsub.js --url=<対象URL> --dry-run
  EVENTSUB_REPLAY_SECRET=<secret> node scripts/replay-maintenance-eventsub.js --url=<対象URL> --limit=<件数>
  npm run replay:maintenance-eventsub -- --url=<対象URL>

オプション:
  --url=<URL>     必須。対象環境のベースURL（例: https://twica-preview.tsubasa-azumagakito.workers.dev）
  --dry-run       実際には処理・削除せず、対象になるエントリだけを確認する
  --limit=<n>     1バッチあたりの取得件数（省略時はサーバー側既定値、上限100にクランプされる）。
                  大きい値（特に上限の100付近）を指定する場合、1エントリあたり
                  最大3秒程度かかりうるため応答が本スクリプトのタイムアウト
                  （${FETCH_TIMEOUT_MS / 1000}秒）に近づく・超える可能性がある。
                  タイムアウトした場合は --limit を下げて複数回に分けて実行すること。
  --help, -h      このヘルプを表示する

シークレット:
  X-Replay-Secret ヘッダーに使うシークレットは環境変数 EVENTSUB_REPLAY_SECRET から読み込む。
  CLI引数では指定できない（シェル履歴・プロセス一覧への漏洩を避けるため）。

このスクリプトは cursor を使って /api/admin/eventsub-replay を listComplete: true になるまで
繰り返し呼び出す。各バッチの結果を累積し、最後にsucceeded/skipped/failed/unknownType/
invalidPayloadの合計件数を表示する。failed が1件でもあれば終了コード1、無ければ0で終了する
（unknownType/invalidPayloadはリトライで解決する種類の失敗ではないため終了コードには含めない）。
`.trim()

/**
 * process.argv から CLI オプションを取り出す純粋関数。
 * @param {string[]} argv process.argv 全体
 * @returns {{ help: boolean, url: string | undefined, dryRun: boolean, limit: number | undefined, limitError: string | undefined }}
 */
function parseArgs(argv) {
  const args = argv.slice(2)
  const help = args.includes('--help') || args.includes('-h')
  const dryRun = args.includes('--dry-run')

  const urlFlag = args.find((a) => a.startsWith('--url='))
  const url = urlFlag ? urlFlag.slice('--url='.length) : undefined

  const limitFlag = args.find((a) => a.startsWith('--limit='))
  let limit
  let limitError
  if (limitFlag) {
    const raw = limitFlag.slice('--limit='.length)
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      limitError = `--limit には正の整数を指定してください: ${raw}`
    } else {
      limit = parsed
    }
  }

  return { help, url, dryRun, limit, limitError }
}

/**
 * CLI引数・環境変数から実行設定を解決する純粋関数。
 * @param {string[]} argv process.argv
 * @param {Record<string, string | undefined>} env process.env
 * @returns {{ help: true } | { error: string } | { baseUrl: string, secret: string, dryRun: boolean, limit: number | undefined }}
 */
function resolveConfig(argv, env) {
  const { help, url, dryRun, limit, limitError } = parseArgs(argv)
  if (help) {
    return { help: true }
  }

  if (limitError) {
    return { error: limitError }
  }

  const trimmedUrl = url && url.trim()
  if (!trimmedUrl) {
    return { error: '--url=<対象URL> は必須です。--help を参照してください。' }
  }
  if (!/^https?:\/\//.test(trimmedUrl)) {
    return { error: `対象URLは http:// または https:// で始まる必要があります: ${trimmedUrl}` }
  }

  const secret = env.EVENTSUB_REPLAY_SECRET
  if (!secret || !secret.trim()) {
    return {
      error:
        '環境変数 EVENTSUB_REPLAY_SECRET が設定されていません。' +
        'シークレットは CLI 引数ではなく環境変数で渡してください。',
    }
  }

  return {
    baseUrl: trimmedUrl.replace(/\/+$/, ''),
    secret,
    dryRun,
    limit,
  }
}

/**
 * 1バッチ分のリクエストボディを組み立てる純粋関数。
 * @param {{ dryRun: boolean, limit: number | undefined, cursor: string | undefined }} params
 * @returns {Record<string, unknown>}
 */
function buildRequestBody(params) {
  const body = {}
  if (params.dryRun) body.dryRun = true
  if (params.limit !== undefined) body.limit = params.limit
  if (params.cursor !== undefined) body.cursor = params.cursor
  return body
}

/**
 * 複数バッチの counts を合算する純粋関数。
 * unknownType/invalidPayload は route.ts 側で新設されたカテゴリ（中-2/低-6）。
 * @param {{ succeeded: number, skipped: number, failed: number, unknownType: number, invalidPayload: number, total: number }} totals
 * @param {{ succeeded: number, skipped: number, failed: number, unknownType: number, invalidPayload: number, total: number }} batchCounts
 * @returns {{ succeeded: number, skipped: number, failed: number, unknownType: number, invalidPayload: number, total: number }}
 */
function addCounts(totals, batchCounts) {
  return {
    succeeded: totals.succeeded + batchCounts.succeeded,
    skipped: totals.skipped + batchCounts.skipped,
    failed: totals.failed + batchCounts.failed,
    unknownType: totals.unknownType + (batchCounts.unknownType || 0),
    invalidPayload: totals.invalidPayload + (batchCounts.invalidPayload || 0),
    total: totals.total + batchCounts.total,
  }
}

/** 1バッチ分のAPIレスポンスを標準出力へ人間可読な形で表示する。 */
function printBatch(batchIndex, response) {
  console.log('')
  console.log(`--- バッチ ${batchIndex} (dryRun=${response.dryRun}) ---`)
  console.log(
    `  succeeded=${response.counts.succeeded} skipped=${response.counts.skipped} ` +
    `failed=${response.counts.failed} unknownType=${response.counts.unknownType} ` +
    `invalidPayload=${response.counts.invalidPayload} total=${response.counts.total}`
  )
  for (const r of response.results) {
    const errorSuffix = r.error ? ` error=${r.error}` : ''
    console.log(`  [${r.outcome}] messageId=${r.messageId} type=${r.subscriptionType} key=${r.key}${errorSuffix}`)
  }
}

/**
 * 1バッチ分のHTTPリクエストを送信する（ネットワークI/Oあり、単体テスト対象外）。
 * @param {{ baseUrl: string, secret: string, dryRun: boolean, limit: number | undefined, cursor: string | undefined }} params
 */
async function requestBatch(params) {
  const url = `${params.baseUrl}${REPLAY_PATH}`
  const body = buildRequestBody(params)

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Replay-Secret': params.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`レスポンスがJSONとしてパースできませんでした (status=${response.status}): ${text.slice(0, 500)}`)
  }

  if (!response.ok) {
    const errorMessage = json && typeof json === 'object' && json.error ? json.error : JSON.stringify(json)
    throw new Error(`リプレイAPIが ${response.status} を返却しました: ${errorMessage}`)
  }

  return json
}

async function main() {
  const resolved = resolveConfig(process.argv, process.env)

  if (resolved.help) {
    console.log(HELP_TEXT)
    return
  }
  if (resolved.error) {
    console.error(`[replay-maintenance-eventsub] ${resolved.error}`)
    console.error('')
    console.error(HELP_TEXT)
    process.exitCode = 1
    return
  }

  const { baseUrl, secret, dryRun, limit } = resolved

  console.log(`[replay-maintenance-eventsub] 対象URL: ${baseUrl}${REPLAY_PATH}`)
  console.log(`[replay-maintenance-eventsub] dryRun=${dryRun} limit=${limit ?? '(サーバー既定値)'}`)

  let cursor
  let batchIndex = 0
  let totals = { succeeded: 0, skipped: 0, failed: 0, unknownType: 0, invalidPayload: 0, total: 0 }
  let listComplete = false

  while (!listComplete) {
    batchIndex += 1
    let response
    try {
      response = await requestBatch({ baseUrl, secret, dryRun, limit, cursor })
    } catch (error) {
      console.error('')
      console.error(`[replay-maintenance-eventsub] バッチ ${batchIndex} の実行に失敗しました: ${error.message}`)
      process.exitCode = 1
      return
    }

    printBatch(batchIndex, response)
    totals = addCounts(totals, response.counts)
    listComplete = response.listComplete
    cursor = response.cursor
  }

  console.log('')
  console.log('========================================================================')
  console.log(
    `[replay-maintenance-eventsub] 完了: ${batchIndex}バッチ処理。合計 ` +
    `succeeded=${totals.succeeded} skipped=${totals.skipped} failed=${totals.failed} ` +
    `unknownType=${totals.unknownType} invalidPayload=${totals.invalidPayload} total=${totals.total}`
  )
  if (totals.unknownType > 0) {
    console.log(
      `[replay-maintenance-eventsub] unknownType が ${totals.unknownType} 件あります。` +
      '未対応のsubscriptionTypeはKVに残しています（TTL 7日）。上記ログの [unknown-type] 行を確認してください。'
    )
  }
  console.log('========================================================================')

  // unknownType/invalidPayload はどちらも本スクリプトの再実行では解決しない
  // （failed のように一時障害からの再試行成功を期待できるものではない）ため、
  // 終了コードには含めない。invalidPayload は reportError 経由で別途
  // GitHub Issue 起票の経路に乗っており、unknownType は上記ログで可視化している。
  process.exitCode = totals.failed > 0 ? 1 : 0
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[replay-maintenance-eventsub] 予期しない例外で終了しました:', error)
    process.exitCode = 1
  })
}

module.exports = {
  parseArgs,
  resolveConfig,
  buildRequestBody,
  addCounts,
}
