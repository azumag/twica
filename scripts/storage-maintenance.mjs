#!/usr/bin/env node

/**
 * Storage maintenance runner / ストレージ台帳の再照合・未使用効果音回収 (#1907)
 *
 * #1896 の残項目として追加した POST /api/internal/storage-maintenance を叩く
 * 薄い CLI。定期実行は workers/error-reporter の STORAGE_MAINTENANCE_CRON（日次）
 * が同じ route を叩く。このスクリプトは手動確認・dry-run・障害時の再実行に使う。
 *
 * シークレット:
 *   STORAGE_MAINTENANCE_SECRET からのみ読む（CLI 引数にしない。シェル履歴・
 *   `ps aux` への漏洩を避ける）。
 *
 * 使い方:
 *   STORAGE_MAINTENANCE_SECRET=<secret> node scripts/storage-maintenance.mjs \
 *     --url=https://twica-preview.example --action=reconcile
 *   STORAGE_MAINTENANCE_SECRET=<secret> node scripts/storage-maintenance.mjs \
 *     --url=https://twica-preview.example --action=collect-unused-sounds
 *     （--execute を付けるまで dry-run。対象キーだけ確認できる）
 *   STORAGE_MAINTENANCE_SECRET=<secret> node scripts/storage-maintenance.mjs \
 *     --url=https://twica-preview.example --action=collect-unused-sounds --execute
 *   npm run storage:maintenance -- --url=<base-url> --action=reconcile
 *
 * 終了コード:
 *   0 = 成功（collect の dry-run も成功）
 *   1 = サーバーがエラーを返した / レスポンス不正
 *   2 = 引数・環境変数の不足
 */

'use strict'

import { pathToFileURL } from 'node:url'

const STORAGE_MAINTENANCE_PATH = '/api/internal/storage-maintenance'
const FETCH_TIMEOUT_MS = 120_000

const HELP_TEXT = `
使い方:
  STORAGE_MAINTENANCE_SECRET=<secret> node scripts/storage-maintenance.mjs --url=<対象URL> --action=<reconcile|collect-unused-sounds> [options]

オプション:
  --url=<URL>              必須。対象環境のベースURL（例: https://twica-preview.tsubasa-azumagakito.workers.dev）
  --action=<name>          reconcile（既定）: blob_files と storage_usage を再照合する
                           collect-unused-sounds: 設定から参照されていない効果音を回収する
  --execute                collect-unused-sounds を実行する。付けない場合は dry-run で候補だけ返す
  --min-age-seconds=<n>    collect で「新しすぎる」として除外する秒数（既定 86400、1以上）
  --max-deletions=<n>      collect の1回あたり削除上限（既定 200、最大 200）
  --max-objects=<n>        collect の1回あたり列挙上限（既定 10000、最大 50000）
  --help, -h               このヘルプを表示する

シークレット:
  x-storage-maintenance-secret ヘッダーに使う値は環境変数
  STORAGE_MAINTENANCE_SECRET から読み込む。CLI 引数では指定できない
  （シェル履歴・プロセス一覧への漏洩を避けるため）。
`.trim()

/**
 * @param {string[]} argv
 * @returns {{ help: boolean, url?: string, action?: string, execute: boolean, minAgeSeconds?: number, maxDeletions?: number, maxObjects?: number, error?: string }}
 */
function parseArgs(argv) {
  const args = argv.slice(2)
  const help = args.includes('--help') || args.includes('-h')
  const execute = args.includes('--execute')

  // typo した --max-deletions 等を黙って無視すると、既定の200件削除に化ける。
  // 既知のフラグ以外は明示的に拒否する。
  const allowedExact = new Set(['--help', '-h', '--execute'])
  const allowedPrefixes = ['--url=', '--action=', '--min-age-seconds=', '--max-deletions=', '--max-objects=']
  const unknown = args.find(
    (arg) => !allowedExact.has(arg) && !allowedPrefixes.some((prefix) => arg.startsWith(prefix)),
  )
  if (unknown) {
    return { help, execute, error: `不明な引数です: ${unknown}` }
  }

  const readFlag = (name) => {
    const prefix = `--${name}=`
    const found = args.find((arg) => arg.startsWith(prefix))
    return found ? found.slice(prefix.length) : undefined
  }

  const readPositiveInteger = (name) => {
    const raw = readFlag(name)
    if (raw === undefined) return { value: undefined }
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { error: `--${name} には正の整数を指定してください: ${raw}` }
    }
    return { value: parsed }
  }

  const minAge = readPositiveInteger('min-age-seconds')
  const maxDeletions = readPositiveInteger('max-deletions')
  const maxObjects = readPositiveInteger('max-objects')
  const error = minAge.error || maxDeletions.error || maxObjects.error
  if (error) {
    return { help, execute, error }
  }

  return {
    help,
    execute,
    url: readFlag('url'),
    action: readFlag('action'),
    minAgeSeconds: minAge.value,
    maxDeletions: maxDeletions.value,
    maxObjects: maxObjects.value,
  }
}

/**
 * @param {{ url?: string, action?: string, error?: string }} parsed
 * @param {Record<string, string | undefined>} env
 * @returns {{ error: string } | { url: string, secret: string, action: string }}
 */
function resolveConfig(parsed, env) {
  if (parsed.error) return { error: parsed.error }
  if (!parsed.url) return { error: '--url は必須です' }

  let url
  try {
    const parsedUrl = new URL(parsed.url)
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname)
    // 共有シークレットを送るため、平文 HTTP はローカル開発の loopback だけ許可する。
    if (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && isLocalHost)) {
      return { error: '--url は https:// を指定してください（localhost のみ http:// を許可）' }
    }
    url = parsedUrl.toString().replace(/\/$/, '')
  } catch {
    return { error: `--url が不正です: ${parsed.url}` }
  }

  const secret = env.STORAGE_MAINTENANCE_SECRET
  if (!secret) {
    return { error: '環境変数 STORAGE_MAINTENANCE_SECRET が設定されていません' }
  }

  const action = parsed.action || 'reconcile'
  if (action !== 'reconcile' && action !== 'collect-unused-sounds') {
    return { error: `--action が不正です: ${action}` }
  }

  return { url, secret, action }
}

async function main() {
  const parsed = parseArgs(process.argv)
  if (parsed.help) {
    console.log(HELP_TEXT)
    return 0
  }

  const config = resolveConfig(parsed, process.env)
  if ('error' in config) {
    console.error(config.error)
    console.error(HELP_TEXT)
    return 2
  }

  const body = { action: config.action }
  if (config.action === 'collect-unused-sounds') {
    body.dryRun = !parsed.execute
    if (parsed.minAgeSeconds !== undefined) body.minAgeSeconds = parsed.minAgeSeconds
    if (parsed.maxDeletions !== undefined) body.maxDeletions = parsed.maxDeletions
    if (parsed.maxObjects !== undefined) body.maxObjects = parsed.maxObjects
  }

  let response
  try {
    response = await fetch(`${config.url}${STORAGE_MAINTENANCE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-storage-maintenance-secret': config.secret,
      },
      body: JSON.stringify(body),
      // リダイレクト追従で secret ヘッダーが別ホストへ転送されるのを防ぐ。
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    console.error('storage-maintenance request failed:', error instanceof Error ? error.message : String(error))
    return 1
  }

  const text = await response.text()
  if (!response.ok) {
    console.error(`storage-maintenance returned ${response.status}: ${text}`)
    return 1
  }

  let result
  try {
    result = JSON.parse(text)
  } catch {
    console.error('storage-maintenance returned invalid JSON')
    return 1
  }

  console.log(JSON.stringify(result, null, 2))

  // collect の部分失敗（R2 削除・台帳減算）は cron が検知できるよう非0で終了する。
  if (result?.action === 'collect-unused-sounds' && result.result) {
    const failed =
      Number(result.result.r2DeleteFailed ?? 0) +
      Number(result.result.ledgerRemoveFailed ?? 0) +
      Number(result.result.ledgerReconcileFailed ?? 0)
    if (failed > 0) {
      console.error(`storage-maintenance completed with ${failed} failure(s)`)
      return 1
    }
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error('storage-maintenance crashed:', error)
      process.exitCode = 1
    })
}

export { parseArgs, resolveConfig, HELP_TEXT }
