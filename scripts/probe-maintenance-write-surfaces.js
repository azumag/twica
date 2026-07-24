#!/usr/bin/env node

/**
 * Maintenance write surface probe / メンテナンス書き込みsurfaceの実地プローブ (#694 Stage 7)
 *
 * 背景:
 * #694 Stage 1-6c で maintenance mode（off/read-only/cutover-validating/
 * incident-read-only の4状態）と、その write guard（案B: middleware一律 +
 * config/maintenance-write-surfaces.json によるallowlist免除）を実装した。
 * scripts/check-maintenance-surfaces.js（Stage 5）は「実routeとinventoryが
 * 同期しているか」を静的に検証するが、それはあくまでコードの整合性チェックで
 * あり、「実際に稼働中のWorkerに対して未認証リクエストを送ったときに、
 * middleware/guard.tsが本当に期待通りの応答を返すか」までは検証しない。
 * issue #694 本文の受け入れ条件「previewでmode on/offと全主要write surfaceを
 * 検証している」に対応するのが本スクリプトである。
 *
 * このスクリプトが検証すること（config/maintenance-write-surfaces.json の
 * maintenanceBehavior別）:
 *   - 'block': 対象 path+method へ未認証リクエスト → 503 かつ
 *     body.error.code が "maintenance_" 始まりであること
 *     （src/middleware.ts の checkMaintenanceWriteBlock は認証チェックより
 *     前にblockするため、未認証でも503が返るのが正しい仕様。Stage 3の
 *     Fableレビューで実装当時に実測確認済みの前提を、本スクリプトで機械的に
 *     継続検証する）
 *   - 'redirect'（GETのみ）: 未認証リクエスト → 302 かつ Location ヘッダーが
 *     "/?maintenance=1" を含むこと（route側が個別に guardWriteRedirect を
 *     呼ぶ経路。src/lib/maintenance/guard.ts 参照）
 *   - 'allow'（/api/auth/logout）: 503 ではないこと（実際のstatusは
 *     CSRF検証失敗等で403等になりうるが、「maintenance由来の503でない」
 *     ことだけを検証する。ログアウト自体は未認証でも副作用が無いため安全）
 *   - 'queue-during-maintenance'（/api/twitch/eventsub）: 503ではないこと
 *     （署名検証がPOSTハンドラの最初のステップであり、未署名リクエストは
 *     DB書き込みに到達する前に403で弾かれる。src/app/api/twitch/eventsub/
 *     route.ts 参照。実際のTwitch通知や課金系処理には一切触れない）
 *
 * 重要な前提条件（実行前に必ず確認すること）:
 * このスクリプトは「対象環境の MAINTENANCE_MODE が off 以外」であることを
 * 前提にした検証である。off のまま実行すると、'block' 系エントリは
 * middlewareを素通りして実routeハンドラに到達し、未認証/未CSRFのため
 * 401/403等（503以外）を返す。このスクリプトはその状態を検知し
 * （block系エントリが1件も503を返さない＝典型的な「モード設定忘れ」の
 * 兆候）、「対象環境がmaintenance modeになっていない可能性」という
 * わかりやすいメッセージで早期終了する（本文中 looksLikeMaintenanceModeOff）。
 *
 * MAINTENANCE_MODE の設定例（docs/history/migration/DB_PHASE2_RUNBOOK.md 4章も参照）:
 *   echo "read-only" | npx wrangler@4.112.0 versions secret put MAINTENANCE_MODE --env=preview
 *   npx wrangler@4.112.0 versions deploy <version-id>@100% --env=preview -y
 *   （wrangler は必ず 4.112.0 を明示する。ローカル既定の 4.61.0 系は本番/preview
 *   Worker に対して無言で exit 1 するバグがある）
 *
 * 使い方:
 *   node scripts/probe-maintenance-write-surfaces.js --url=<対象URL>
 *   node scripts/probe-maintenance-write-surfaces.js <対象URL>
 *   MAINTENANCE_PROBE_BASE_URL=<対象URL> node scripts/probe-maintenance-write-surfaces.js
 *   npm run probe:maintenance -- --url=<対象URL>
 *
 * 例:
 *   node scripts/probe-maintenance-write-surfaces.js \
 *     --url=https://twica-preview.tsubasa-azumagakito.workers.dev
 *
 * **注意（CIでは実行しない）**: このスクリプトは実際に稼働中の外部Worker
 * （preview等）へ本物のHTTPリクエストを送る運用スクリプトである。
 * scripts/check-migration-order.js や scripts/check-maintenance-surfaces.js
 * のようなpushごとの機械的検証とは異なり、対象環境がmaintenance mode中で
 * ある必要があるという副作用のない通常運用時には成立しない前提を持つため、
 * CIワークフロー（.github/workflows/*.yml）には一切組み込まない。
 * package.json の script 名も `probe:maintenance` とし、`check:*` 系
 * （CI実行前提）と命名で区別している。実行はリポジトリオーナーが
 * 実際にmaintenance modeを有効化した対象環境に対して手動で行う。
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..')
const INVENTORY_PATH = path.join(REPO_ROOT, 'config', 'maintenance-write-surfaces.json')

/** 対象URLを指定する環境変数名。CLI引数が優先され、これはフォールバック。 */
const ENV_VAR_NAME = 'MAINTENANCE_PROBE_BASE_URL'

/**
 * Next.js の動的セグメント（例: "[id]"）を実際にHTTPリクエスト可能な
 * 具体的な値に置き換えるためのプレースホルダ。
 *
 * 任意の値で構わない理由: 'block' エントリは middleware（src/middleware.ts の
 * checkMaintenanceWriteBlock）が、実routeハンドラに到達する前に一律で
 * ブロックする。判定は pathname の allowlist 非一致のみで行われ、対象
 * リソース（例: 実在する card id）が存在するかどうかには一切依存しない。
 * そのため実在しないダミーIDを送っても 'block' の検証としては正しく機能する。
 */
const DYNAMIC_SEGMENT_PLACEHOLDER = 'probe-dummy-id'

/** fetch 1件あたりのタイムアウト（ミリ秒）。対象Workerが無応答の場合に
 * スクリプト全体がハングし続けるのを防ぐ。 */
const FETCH_TIMEOUT_MS = 10_000

/** ボディを送るHTTPメソッド（block検証では中身は読まれない。allow/queue検証
 * 側の実routeハンドラが JSON.parse 等でエラーにならないよう最小限の妥当な
 * JSONを送る）。 */
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH'])

const HELP_TEXT = `
使い方:
  node scripts/probe-maintenance-write-surfaces.js --url=<対象URL>
  node scripts/probe-maintenance-write-surfaces.js <対象URL>
  ${ENV_VAR_NAME}=<対象URL> node scripts/probe-maintenance-write-surfaces.js
  npm run probe:maintenance -- --url=<対象URL>

例:
  node scripts/probe-maintenance-write-surfaces.js --url=https://twica-preview.tsubasa-azumagakito.workers.dev

前提条件（重要）:
  このスクリプトは「対象環境の MAINTENANCE_MODE が off 以外」であることを
  前提にした検証です。実行前に対象環境（例: preview）の MAINTENANCE_MODE を
  read-only 等に設定してください。off のまま実行すると block系エントリが
  1件も503を返さず、スクリプトは「maintenance modeになっていない可能性が
  あります」というメッセージで早期終了します。

  MAINTENANCE_MODE の設定例（wrangler は必ず 4.112.0 を明示。4.61.0系は
  本番/preview Workerに対して無言で exit 1 するバグがある）:
    echo "read-only" | npx wrangler@4.112.0 versions secret put MAINTENANCE_MODE --env=preview
    npx wrangler@4.112.0 versions deploy <version-id>@100% --env=preview -y

  詳細は docs/history/migration/DB_PHASE2_RUNBOOK.md の4章を参照してください。

このスクリプトはCIでは実行しません（外部Workerへの実リクエストを伴うため）。
config/maintenance-write-surfaces.json の全エントリについて、実際に稼働中の
Workerでmaintenance modeの挙動が期待通りかを機械的に検証する運用スクリプトです。
`.trim()

/**
 * process.argv から `--help`/`-h` と対象URLを取り出す純粋関数。
 * @param {string[]} argv process.argv 全体（node実行パス・スクリプトパスを含む）
 * @returns {{ help: boolean, url: string | undefined }}
 */
function parseArgs(argv) {
  const args = argv.slice(2)
  const help = args.includes('--help') || args.includes('-h')
  const urlFlag = args.find((a) => a.startsWith('--url='))
  const positional = args.find((a) => !a.startsWith('-'))
  const url = urlFlag ? urlFlag.slice('--url='.length) : positional
  return { help, url }
}

/**
 * CLI引数・環境変数から対象URLを解決する純粋関数（CLI引数優先）。
 * @param {string[]} argv process.argv
 * @param {Record<string, string | undefined>} env process.env
 * @returns {{ help: true } | { error: string } | { baseUrl: string }}
 */
function resolveBaseUrl(argv, env) {
  const { help, url: cliUrl } = parseArgs(argv)
  if (help) {
    return { help: true }
  }

  const trimmedCliUrl = cliUrl && cliUrl.trim()
  const trimmedEnvUrl = env[ENV_VAR_NAME] && env[ENV_VAR_NAME].trim()
  const raw = trimmedCliUrl || trimmedEnvUrl

  if (!raw) {
    return {
      error:
        '対象URLが指定されていません。CLI引数（--url=<URL> または位置引数）か、' +
        `環境変数 ${ENV_VAR_NAME} のいずれかで指定してください。`,
    }
  }

  if (!/^https?:\/\//.test(raw)) {
    return { error: `対象URLは http:// または https:// で始まる必要があります: ${raw}` }
  }

  // 末尾スラッシュを正規化する（config側のpathは常に "/" で始まるため、
  // そのまま連結してもURLが崩れないようにする）。
  return { baseUrl: raw.replace(/\/+$/, '') }
}

/**
 * "[id]" のようなNext.js動的セグメントをプレースホルダ値へ置換する純粋関数。
 * @param {string} pathPattern config内の path（例: "/api/cards/[id]"）
 * @returns {string}
 */
function substituteDynamicSegments(pathPattern) {
  return pathPattern.replace(/\[[^[\]]+\]/g, DYNAMIC_SEGMENT_PLACEHOLDER)
}

/**
 * ベースURLと（動的セグメント置換済みの）pathからリクエスト先URLを組み立てる純粋関数。
 * @param {string} baseUrl 末尾スラッシュ除去済み
 * @param {string} resolvedPath "/" で始まるpath
 * @returns {string}
 */
function buildProbeUrl(baseUrl, resolvedPath) {
  return `${baseUrl}${resolvedPath}`
}

/**
 * config/maintenance-write-surfaces.json のエントリ一覧を、
 * 「1リクエスト = 1チェック」の単位までフラット化する純粋関数。
 * 1エントリが複数methodsを持つ場合（例: PUT+DELETE）はmethodごとに分割する。
 *
 * @param {Array<{ path: string, methods: string[], maintenanceBehavior: string }>} inventory
 * @returns {Array<{ originalPath: string, path: string, method: string, behavior: string, category: string }>}
 */
function flattenChecks(inventory) {
  const checks = []
  for (const entry of inventory) {
    for (const method of entry.methods) {
      checks.push({
        originalPath: entry.path,
        path: substituteDynamicSegments(entry.path),
        method,
        behavior: entry.maintenanceBehavior,
        category: entry.category,
      })
    }
  }
  return checks
}

/**
 * maintenance系のエラーコードかどうかを判定する純粋関数。
 *
 * src/lib/maintenance/state.ts の MAINTENANCE_ERROR_CODE_BY_MODE
 * （'maintenance_read_only' | 'maintenance_cutover_validating' |
 * 'maintenance_incident_read_only'）と対応する値だが、このスクリプトは
 * ビルドパイプラインを経ないプレーンなNode CLIスクリプトのためTSモジュールを
 * 直接importできない。3値を個別に書き写すと state.ts 側にmodeが追加された
 * 際にこのスクリプトだけ追従し忘れるドリフトリスクがあるため、issue #694の
 * 検証要求どおり "maintenance_" prefix一致という緩い判定に留める。
 *
 * @param {unknown} code
 * @returns {boolean}
 */
function isMaintenanceErrorCode(code) {
  return typeof code === 'string' && /^maintenance_/.test(code)
}

/**
 * 'block' エントリの検証結果を判定する純粋関数。
 * @param {number | null} status
 * @param {unknown} jsonBody
 * @returns {{ ok: boolean, detail: string }}
 */
function evaluateBlockCheck(status, jsonBody) {
  if (status !== 503) {
    return { ok: false, detail: `503を期待しましたが ${status ?? '(応答なし)'} が返却されました` }
  }

  const code =
    jsonBody && typeof jsonBody === 'object' && jsonBody.error && typeof jsonBody.error.code === 'string'
      ? jsonBody.error.code
      : null

  if (!isMaintenanceErrorCode(code)) {
    return {
      ok: false,
      detail: `503でしたが body.error.code が "maintenance_*" ではありません (code=${code ?? '不明'})`,
    }
  }

  return { ok: true, detail: `OK (503, code=${code})` }
}

/**
 * 'redirect' エントリの検証結果を判定する純粋関数。
 * @param {number | null} status
 * @param {string | null} locationHeader
 * @returns {{ ok: boolean, detail: string }}
 */
function evaluateRedirectCheck(status, locationHeader) {
  if (status !== 302) {
    return { ok: false, detail: `302を期待しましたが ${status ?? '(応答なし)'} が返却されました` }
  }
  if (!locationHeader || !locationHeader.includes('/?maintenance=1')) {
    return {
      ok: false,
      detail: `Location ヘッダーに "/?maintenance=1" が含まれません (Location=${locationHeader ?? '(なし)'})`,
    }
  }
  return { ok: true, detail: `OK (302, Location=${locationHeader})` }
}

/**
 * 'allow' / 'queue-during-maintenance' エントリの検証結果を判定する純粋関数。
 * 「503ではないこと」だけを見る（実際のstatusは認証・CSRF・署名検証等の
 * 事情でどんな値にもなりうるため、それ自体は検証対象にしない）。
 * @param {number | null} status
 * @returns {{ ok: boolean, detail: string }}
 */
function evaluateExemptCheck(status) {
  if (status === 503) {
    return {
      ok: false,
      detail: '503 (maintenanceによるブロックの疑い) が返却されました。allowlist免除が機能していない可能性があります',
    }
  }
  return { ok: true, detail: `OK (${status ?? '(応答なし)'}, 503ではありません)` }
}

/**
 * 1件の実行結果 (runCheck の戻り値) を behavior に応じて判定へディスパッチする。
 * ネットワークエラー（fetch自体が例外を投げた）は behavior に関わらず常に失敗扱い。
 * @param {{ behavior: string, status: number | null, jsonBody: unknown, locationHeader: string | null, networkError: string | null }} result
 * @returns {{ ok: boolean, detail: string }}
 */
function evaluateCheckResult(result) {
  if (result.networkError) {
    return { ok: false, detail: `ネットワークエラー: ${result.networkError}` }
  }

  switch (result.behavior) {
    case 'block':
      return evaluateBlockCheck(result.status, result.jsonBody)
    case 'redirect':
      return evaluateRedirectCheck(result.status, result.locationHeader)
    case 'allow':
    case 'queue-during-maintenance':
      return evaluateExemptCheck(result.status)
    default:
      return { ok: false, detail: `未知の maintenanceBehavior です: ${result.behavior}` }
  }
}

/**
 * 'block' チェック結果一覧から、「対象環境がmaintenance mode中ではなさそう」
 * かどうかを判定する純粋関数。
 *
 * 判定基準（全件が503以外の場合のみtrue。1件でも503があれば false）:
 * mode=offの典型的な兆候は「block系エントリが1件残らず503以外を返す」こと
 * （off中はmiddlewareが素通しし、実routeハンドラの認証/CSRF等で403/401等を
 * 返すため）。この基準を「1件でも503以外があれば」にすると、一部のroute
 * だけに実装バグ・regressionがあるケース（他は正しく503を返している）まで
 * mode=off扱いにしてしまい、本来報告すべき個別バグを早期終了で握りつぶす。
 * 「全件」を条件にすることで、両ケースを区別する:
 *   - 全件503以外 → 環境設定ミス（mode=off）の可能性が高い → 早期終了
 *   - 一部のみ503以外 → 個別routeの実装バグの可能性 → 通常のFAIL項目として報告
 *
 * @param {Array<{ status: number | null }>} blockResults
 * @returns {boolean}
 */
function looksLikeMaintenanceModeOff(blockResults) {
  if (blockResults.length === 0) return false
  return blockResults.every((r) => r.status !== 503)
}

/**
 * 全件がネットワークエラー（対象URLへ到達すらできない）かどうかを判定する純粋関数。
 * looksLikeMaintenanceModeOff は networkError も「503ではない」として一致して
 * しまうため、「そもそも到達できていない」ケースを「mode=offかもしれない」より
 * 先に検出し、より的確なエラーメッセージ（接続性の問題）を出す。
 * @param {Array<{ networkError: string | null }>} results
 * @returns {boolean}
 */
function allNetworkErrors(results) {
  return results.length > 0 && results.every((r) => r.networkError)
}

/** レスポンスのJSONボディを安全にパースする（失敗時はnullを返し、例外を投げない）。 */
async function parseJsonBodySafely(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * 1件のチェックに対して実際にHTTPリクエストを送る（ネットワークI/Oあり、単体テスト対象外）。
 *
 * redirect: 'manual' を指定する理由: 'redirect' エントリの302自体を検証対象に
 * するため、fetchに自動追従させてはならない（追従すると302の情報が失われ、
 * 追従先の200等で誤判定してしまう）。'block'/'allow'/'queue-during-maintenance'
 * では通常302は発生しない想定だが、統一した挙動にする（Node実装（undici）では
 * redirect: 'manual' でも実際のstatus/Locationヘッダーがそのまま読めることを
 * 事前に確認済み。ブラウザのopaque-redirect制限はNode fetchには適用されない）。
 *
 * @param {string} baseUrl
 * @param {{ path: string, method: string }} check
 * @returns {Promise<{ status: number | null, locationHeader: string | null, jsonBody: unknown, networkError: string | null, url: string }>}
 */
async function runCheck(baseUrl, check) {
  const url = buildProbeUrl(baseUrl, check.path)
  /** @type {RequestInit} */
  const init = {
    method: check.method,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }
  if (METHODS_WITH_BODY.has(check.method)) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = '{}'
  }

  try {
    const response = await fetch(url, init)
    const jsonBody = await parseJsonBodySafely(response)
    return {
      url,
      status: response.status,
      locationHeader: response.headers.get('location'),
      jsonBody,
      networkError: null,
    }
  } catch (error) {
    return {
      url,
      status: null,
      locationHeader: null,
      jsonBody: null,
      networkError: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 検証結果一覧を人間可読なサマリーとして標準出力へ出す。 */
function printSummary(results) {
  const passed = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)

  console.log('')
  console.log('----------------------------------------------------------------------')
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL'
    console.log(`[${mark}] ${r.behavior.padEnd(24)} ${r.method.padEnd(6)} ${r.originalPath} - ${r.detail}`)
  }
  console.log('----------------------------------------------------------------------')
  console.log(`[probe-maintenance] 合計 ${results.length}件: 成功 ${passed.length}件 / 失敗 ${failed.length}件`)

  if (failed.length > 0) {
    console.log('')
    console.log('失敗した項目の詳細:')
    for (const r of failed) {
      console.log(`  - ${r.method} ${r.originalPath} (${r.behavior}): ${r.detail}`)
      console.log(`    url=${r.url}`)
    }
  }
}

async function main() {
  const resolved = resolveBaseUrl(process.argv, process.env)

  if (resolved.help) {
    console.log(HELP_TEXT)
    return
  }
  if (resolved.error) {
    console.error(`[probe-maintenance] ${resolved.error}`)
    console.error('')
    console.error(HELP_TEXT)
    process.exitCode = 1
    return
  }

  const baseUrl = resolved.baseUrl

  let inventory
  try {
    inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'))
  } catch (err) {
    console.error(
      `[probe-maintenance] config/maintenance-write-surfaces.json の読み込み/パースに失敗しました: ${
        err && err.message ? err.message : err
      }`
    )
    process.exitCode = 1
    return
  }

  console.log(`[probe-maintenance] 対象URL: ${baseUrl}`)
  console.log(
    '[probe-maintenance] 前提: 対象環境の MAINTENANCE_MODE が off 以外に設定されていること（未確認の場合は --help 参照）'
  )

  const allChecks = flattenChecks(inventory)
  const blockChecks = allChecks.filter((c) => c.behavior === 'block')
  const otherChecks = allChecks.filter((c) => c.behavior !== 'block')

  console.log(`[probe-maintenance] block系 ${blockChecks.length}件を検証中...`)
  const blockRuns = []
  for (const check of blockChecks) {
    blockRuns.push({ ...check, ...(await runCheck(baseUrl, check)) })
  }

  if (allNetworkErrors(blockRuns)) {
    console.error('')
    console.error('========================================================================')
    console.error('[probe-maintenance] 中断: 対象URLへの接続に全件失敗しました。')
    console.error(`URLの指定が正しいか（${baseUrl}）、対象Workerが起動しているかを確認してください。`)
    console.error(`エラー例: ${blockRuns[0].networkError}`)
    console.error('========================================================================')
    process.exitCode = 1
    return
  }

  if (looksLikeMaintenanceModeOff(blockRuns)) {
    console.error('')
    console.error('========================================================================')
    console.error('[probe-maintenance] 中断: block系エントリが1件も503を返しませんでした。')
    console.error('対象環境の MAINTENANCE_MODE が off のままになっている可能性があります。')
    console.error('preview等の対象環境で MAINTENANCE_MODE を read-only 等 (off以外) に')
    console.error('設定してから再実行してください。設定手順は docs/history/migration/DB_PHASE2_RUNBOOK.md')
    console.error('の4章、および本スクリプトの --help を参照。')
    console.error('========================================================================')
    for (const r of blockRuns) {
      const statusLabel = r.networkError ? `network error: ${r.networkError}` : String(r.status)
      console.error(`  - ${r.method} ${r.originalPath}: status=${statusLabel}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`[probe-maintenance] redirect/allow/queue系 ${otherChecks.length}件を検証中...`)
  const otherRuns = []
  for (const check of otherChecks) {
    otherRuns.push({ ...check, ...(await runCheck(baseUrl, check)) })
  }

  const allResults = [...blockRuns, ...otherRuns].map((r) => ({ ...r, ...evaluateCheckResult(r) }))

  printSummary(allResults)

  const hasFailure = allResults.some((r) => !r.ok)
  process.exitCode = hasFailure ? 1 : 0
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[probe-maintenance] 予期しない例外で終了しました:', error)
    process.exitCode = 1
  })
}

module.exports = {
  parseArgs,
  resolveBaseUrl,
  substituteDynamicSegments,
  buildProbeUrl,
  flattenChecks,
  isMaintenanceErrorCode,
  evaluateBlockCheck,
  evaluateRedirectCheck,
  evaluateExemptCheck,
  evaluateCheckResult,
  looksLikeMaintenanceModeOff,
  allNetworkErrors,
}
