#!/usr/bin/env node

/**
 * twica_meta.database_identity 行のseeding CLI / Issue #697 Chunk 1 タスク3
 *
 * 背景:
 * `environment`/`provider`/`instance_id` はDBインスタンスごとに異なる値であり、静的DDLには
 * 埋め込めない。本CLIは4つの実インスタンス（Supabase prod/preview、PlanetScale prod/preview）
 * それぞれに対して個別に手動実行することを想定する（自動化はしない。むしろ手動実行することで
 * 「間違ったDBに間違った値をseedする」事故を防ぐ）。
 *
 * 使い方:
 *   DATABASE_URL="postgres://..." node scripts/db-cutover/init-identity.mjs \
 *     --environment=production --provider=planetscale
 *   npm run db:cutover:init-identity -- --environment=preview --provider=supabase
 *
 *   既に行が存在する場合はデフォルトで拒否する（上書きしない）。上書きするには --force を
 *   明示指定する（instance_id自体は初回seed時の値のまま変わらない。identity-store.mjsの
 *   decideSeedAction/seedIdentity参照）。
 *
 * 接続文字列について:
 * DATABASE_URL は環境変数からのみ読む（scripts/db-migrate.js と同じ方針。CLI引数にすると
 * シェル履歴・`ps aux` 等に平文で残るため）。Issue #697本文は
 * `--database-url=<env var名 or 直接値>` というCLI引数案を例示していたが、本プロジェクトの
 * 既存流儀（db-migrate.js/export-public-schema.mjs、いずれもDATABASE_URLを環境変数専用にしている）
 * との一貫性を優先し、CLI引数化はしない設計にした（Issue #697本文の「引数の正確な形式は
 * db-migrate.jsの既存CLI引数パーサ流儀に合わせて設計してよい」という許可・および
 * db:cutover:verify側の `--source-url`/`--target-url`（または環境変数）という文言に基づく判断）。
 */

'use strict'

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import postgres from 'postgres'
import {
  ensureIdentitySchema,
  seedIdentity,
  VALID_IDENTITY_ENVIRONMENTS,
  VALID_IDENTITY_PROVIDERS,
} from './identity-store.mjs'

const require = createRequire(import.meta.url)
const core = require('../lib/db-migrate-core.js')

const KNOWN_BOOLEAN_FLAGS = ['--help', '-h', '--force']

const HELP_TEXT = `
使い方:
  DATABASE_URL="postgres://..." node scripts/db-cutover/init-identity.mjs --environment=<production|preview> --provider=<supabase|planetscale> [--force]
  npm run db:cutover:init-identity -- --environment=production --provider=planetscale

説明:
  接続先DBの twica_meta.database_identity に、このDBインスタンス自身の識別情報
  （environment/provider/instance_id）を1行seedする。4つの実インスタンス
  （Supabase prod/preview、PlanetScale prod/preview）それぞれに対して手動で個別実行すること
  （自動化しない設計。誤ったDBへのseed事故を防ぐため、実行前に接続先ホスト名を表示する）。

オプション:
  --environment=<production|preview>   必須。省略・不正値は即エラー（推測しない）
  --provider=<supabase|planetscale>    必須。省略・不正値は即エラー（推測しない）
  --force                              既に行が存在する場合でも上書きする
                                        （instance_id自体は初回seed時の値を維持する）
  --help, -h                           このヘルプを表示する

環境変数:
  DATABASE_URL   接続文字列（必須。CLI引数では受け付けない。シェル履歴への漏洩防止）
`.trim()

/**
 * CLI引数を解析する純粋関数。db-migrate.js の parseArgs と同じ「未知フラグ・余剰位置引数を
 * 黙って無視しない」流儀。
 * @param {string[]} argv
 */
export function parseInitIdentityArgs(argv) {
  const args = argv.slice(2)
  const help = args.includes('--help') || args.includes('-h')
  const force = args.includes('--force')

  let environmentFlag
  let providerFlag
  const unknownArgs = []
  // オーケストレーターレビュー Minor-7対応（cli-args.mjsと同じ理由で、こちらのCLIにも適用する）:
  // 同一フラグの重複指定を黙って後勝ちにせず、明示的に拒否する。
  const seenFlags = new Set()
  const duplicateArgs = []
  for (const arg of args) {
    if (KNOWN_BOOLEAN_FLAGS.includes(arg)) continue
    if (arg.startsWith('--environment=')) {
      if (seenFlags.has('--environment=')) {
        duplicateArgs.push(arg)
        continue
      }
      seenFlags.add('--environment=')
      environmentFlag = arg
      continue
    }
    if (arg.startsWith('--provider=')) {
      if (seenFlags.has('--provider=')) {
        duplicateArgs.push(arg)
        continue
      }
      seenFlags.add('--provider=')
      providerFlag = arg
      continue
    }
    unknownArgs.push(arg)
  }

  const environment = environmentFlag ? environmentFlag.slice('--environment='.length) : undefined
  const provider = providerFlag ? providerFlag.slice('--provider='.length) : undefined
  return { help, force, environment, provider, unknownArgs, duplicateArgs }
}

/**
 * CLI引数・環境変数から実行設定を解決する純粋関数。help/error/正常系の3値を返す
 * （db-migrate.js の resolveConfig と同じ流儀）。
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export function resolveInitIdentityConfig(argv, env) {
  const { help, force, environment, provider, unknownArgs, duplicateArgs } = parseInitIdentityArgs(argv)
  if (help) return { help: true }

  if (unknownArgs.length > 0) {
    return { error: `不明な引数です: ${unknownArgs.join(', ')}` }
  }
  if (duplicateArgs.length > 0) {
    return { error: `フラグが重複して指定されています: ${duplicateArgs.join(', ')}` }
  }

  if (!environment) {
    return {
      error: `--environment は必須です（${VALID_IDENTITY_ENVIRONMENTS.join('|')} のいずれかを指定してください。省略時の推測は行いません）。`,
    }
  }
  if (!VALID_IDENTITY_ENVIRONMENTS.includes(environment)) {
    return { error: `--environment には ${VALID_IDENTITY_ENVIRONMENTS.join('/')} のいずれかを指定してください: ${environment}` }
  }

  if (!provider) {
    return {
      error: `--provider は必須です（${VALID_IDENTITY_PROVIDERS.join('|')} のいずれかを指定してください。省略時の推測は行いません）。`,
    }
  }
  if (!VALID_IDENTITY_PROVIDERS.includes(provider)) {
    return { error: `--provider には ${VALID_IDENTITY_PROVIDERS.join('/')} のいずれかを指定してください: ${provider}` }
  }

  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl || !databaseUrl.trim()) {
    return { error: '環境変数 DATABASE_URL が設定されていません。接続文字列は環境変数でのみ受け付けます（CLI引数不可）。' }
  }

  return { environment, provider, force, databaseUrl }
}

async function main() {
  const resolved = resolveInitIdentityConfig(process.argv, process.env)

  if (resolved.help) {
    console.log(HELP_TEXT)
    return 0
  }
  if (resolved.error) {
    console.error(`[init-identity] ${resolved.error}`)
    console.error('')
    console.error(HELP_TEXT)
    return 1
  }

  const { environment, provider, force, databaseUrl } = resolved

  // 誤ったDBへのseed事故防止（Issue #697本文タスク3）: 実行前に接続先ホスト名を
  // 目視確認できるよう明示的にログ出力する。redactConnectionStringはパスワードのみ
  // マスクしホスト名は残す設計のため、そのまま使う。
  const redactedUrl = core.redactConnectionString(databaseUrl)
  console.log('[init-identity] ============================================================')
  console.log(`[init-identity] 接続先: ${redactedUrl}`)
  console.log(`[init-identity] seedする値: environment=${environment} provider=${provider} force=${force}`)
  console.log('[init-identity] 上記の接続先ホスト名が意図したDBと一致していることを目視確認してください。')
  console.log('[init-identity] ============================================================')

  const sql = postgres(core.stripPostgresJsIncompatibleSslParams(databaseUrl), { max: 1, connect_timeout: 15 })

  let exitCode = 2
  try {
    await ensureIdentitySchema(sql)
    const result = await seedIdentity(sql, { environment, provider, force })

    if (result.outcome === 'rejected') {
      console.error(
        '[init-identity] 既に twica_meta.database_identity に行が存在します（上書きしません）:'
      )
      for (const row of result.existingRows) {
        console.error(`  environment=${row.environment} provider=${row.provider} instance_id=${row.instance_id}`)
      }
      console.error('[init-identity] 上書きする場合は --force を指定して再実行してください。')
      exitCode = 1
    } else if (result.outcome === 'inserted') {
      console.log(
        `[init-identity] 新規seed完了: environment=${environment} provider=${provider} instance_id=${result.instanceId} initialized_at=${result.initializedAt.toISOString()}`
      )
      exitCode = 0
    } else {
      // overwritten
      console.log(
        `[init-identity] --force により上書きしました。instance_id は初回seed時の値を維持しています。`
      )
      console.log(`[init-identity] 上書き前の行: ${result.previousRows.map((r) => `${r.environment}/${r.provider}`).join(', ')}`)
      console.log(
        `[init-identity] 上書き後: environment=${environment} provider=${provider} instance_id=${result.instanceId} initialized_at=${result.initializedAt.toISOString()}`
      )
      exitCode = 0
    }
  } catch (error) {
    const message = core.redactSecretsFromText(error instanceof Error ? error.message : String(error), databaseUrl)
    console.error(`[init-identity] 予期しないエラーで終了しました: ${message}`)
    exitCode = 2
  } finally {
    await sql.end({ timeout: 5 })
  }
  return exitCode
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      // Minor-3（Fableレビュー、verify.mjsと同じ対応）: main() 内部の try/catch がカバーしない
      // 極端なケース（postgres()自体の同期例外等）でも、redactionを経ずに生のスタックトレースが
      // 出力されないようにする。
      const message = core.redactSecretsFromText(String(error?.stack ?? error), process.env.DATABASE_URL)
      console.error('[init-identity] 予期しない例外で終了しました:', message)
      process.exitCode = 2
    })
}
