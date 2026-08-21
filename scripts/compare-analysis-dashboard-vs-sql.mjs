#!/usr/bin/env node

/**
 * analysis dashboard の主要集計を、`get_analysis_*()` RPC とは独立に計算した
 * 基礎集計SQLと突き合わせる検証スクリプト (#1077)
 *
 * 背景:
 *   docs/QA.md の Preview 実経路ゲート #6「analysis dashboard の主要集計が
 *   PlanetScale の値と一致することを確認する」は、これまでダッシュボードを
 *   ブラウザで開いて目視するだけの手動確認だった。ダッシュボードの表示値は
 *   `analysis/dev/adminApiPg.ts` 経由で `get_analysis_*()` RPC
 *   （00073_add_analysis_dashboard_rpcs.sql / 20260731120000_paginate_analysis_dashboard.sql）
 *   を呼んでいるだけなので、RPC自体にバグがあってもブラウザ目視では検出できない。
 *   このスクリプトは RPC を経由しない素朴な COUNT/GROUP BY を独立に発行し、
 *   RPC の戻り値と数値が一致するかを機械的に検証する（#1077 Issueの
 *   「既存の自動比較workflow/scriptはありません」を埋める）。
 *
 * 検証範囲の限界 (#1081 PR 2回目レビュー【任意】指摘):
 *   `fetchBasicAggregates` の today/week/month 境界式は RPC 側の定義をほぼ逐語的に
 *   書き写している。そのため検出できるのは主に「RPCの欠落・戻り値の形状変化・
 *   実装ドリフト（RPCだけが後から書き換わり基礎集計とズレるケース）」であり、
 *   境界定義そのものが最初から両側で同じ誤りを持っていた場合（例: `weekGacha`の
 *   意図が実は暦週であるべきなのに両方とも直近7日で実装されている、等）は
 *   この比較では検出できない。totalUsers/totalStreamers/totalCards等の単純な
 *   全件COUNTは書き写しの余地がほぼ無いため、この限界は主に日次境界系の指標に限られる。
 *
 * 対象外:
 *   本スクリプトは接続文字列を要求するだけで、preview専用の限定readロールを
 *   自動で払い出すものではない。preview用ロールの発行・接続文字列の安全な
 *   実行環境への注入は運用側の作業であり（docs/analysis-dashboard-db-permissions.md
 *   「ロール変更は PlanetScale の管理接続を持つ担当者が...」参照）、本スクリプトの
 *   スコープ外。
 *
 * 接続文字列は `DASHBOARD_DATABASE_URL` のみを受け付ける（`DATABASE_URL_PLANETSCALE`
 * や `PLANETSCALE_DATABASE_URL` へはフォールバックしない）。#1077 PR初版レビュー
 * 【必須】指摘: この2つは用途・権限が別の接続文字列であり
 * （`DATABASE_URL_PLANETSCALE` は `next dev` 用のアプリ接続、
 *  `PLANETSCALE_DATABASE_URL` は migration/DDL 用の管理接続。いずれもdashboard用の
 *  限定readロールではない）、フォールバックすると「previewを検証したつもりで
 *  本番へ管理権限で接続し、しかも成功扱いになる」事故が起きうる。
 *  `analysis/dev/adminApiPg.ts` の `resolveDashboardDatabaseUrl`（「無関係な値へ
 *  黙ってフォールバックさせず明示的に失敗させる」#570と同じ安全側方針）と同じ
 *  単一契約に揃える。
 *
 * 使い方:
 *   DASHBOARD_DATABASE_URL="postgres://..." node scripts/compare-analysis-dashboard-vs-sql.mjs
 *   （preview / production の限定readロール接続文字列を渡すこと。
 *    DB接続が必要なためCIでは実行しない）
 *
 * スナップショット一貫性について (#1077 PR初版レビュー【必須】指摘):
 *   基礎集計クエリとRPC呼び出しを別々のトランザクションで発行すると、本ゲートの想定運用
 *   （docs/QA.md「実チャネルポイント引き換えを複数回行う」直後に実行する）では、比較中に
 *   起きる書き込みや`weekGacha`の移動窓境界の出入りだけでRPCのバグが無くても不一致が
 *   出る（誤検知でIssueを起票しうる）。全クエリを`scripts/db-cutover/snapshot.mjs`の
 *   `withReadOnlySnapshot`（`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`、
 *   常にROLLBACK）に包み、単一スナップショット上で発行することでこれを防ぐ。
 *
 * 出力上の注意:
 *   差分調査のためその場でターミナルへ数値を表示する。この出力をIssue/PR/ログへ
 *   恒久的に転記しない（CLAUDE.mdのredaction方針、docs/QA.mdの証拠redaction方針と
 *   同じ理由）。エラーメッセージは`redactSecretsFromText`で接続文字列のパスワード部分を
 *   除去してから出力する。
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import postgres from 'postgres'
import { withReadOnlySnapshot } from './db-cutover/snapshot.mjs'

const require = createRequire(import.meta.url)
const core = require('./lib/db-migrate-core.js')

/** `analysis/dev/adminApiPg.ts` の `resolveDashboardDatabaseUrl` と同じ単一契約。 */
function resolveDashboardDatabaseUrl(env) {
  return env.DASHBOARD_DATABASE_URL?.trim() || ''
}

/**
 * `get_analysis_*()` RPCを経由しない基礎集計。RPC定義
 * （00073_add_analysis_dashboard_rpcs.sql の get_analysis_overview /
 *   get_analysis_gacha_summary、20260731120000_paginate_analysis_dashboard.sql の
 *   get_analysis_users_summary / get_analysis_streamers_summary）と同じ境界定義
 *  （today = date_trunc('day', now())、week = now() - interval '7 days'、
 *   month = date_trunc('month', now())）を独立に書き下す。
 *
 * 呼び出し元は必ず`withReadOnlySnapshot`のcallback内（トランザクションスコープの`tx`）で
 * 呼ぶこと。トップレベルの`sql`を渡すと`fetchRpcAggregates`と別スナップショットになり、
 * 比較の一貫性が崩れる。
 *
 * rarityDistributionは配列のため、この関数では { [rarity]: count } のオブジェクトに
 * 変換してRPC側と比較しやすくする。
 */
async function fetchBasicAggregates(tx) {
  const [totals] = await tx`
    SELECT
      (SELECT COUNT(*)::INTEGER FROM users) AS total_users,
      (SELECT COUNT(*)::INTEGER FROM streamers) AS total_streamers,
      (SELECT COUNT(*)::INTEGER FROM cards) AS total_cards,
      (SELECT COUNT(*)::INTEGER FROM user_cards) AS total_user_cards,
      (SELECT COUNT(*)::INTEGER FROM users WHERE tos_accepted_at IS NOT NULL) AS users_with_tos,
      (SELECT COUNT(DISTINCT user_id)::INTEGER FROM user_cards) AS users_with_cards,
      (SELECT COUNT(*)::INTEGER FROM gacha_history) AS total_gacha,
      (SELECT COUNT(DISTINCT user_twitch_id)::INTEGER FROM gacha_history) AS unique_users,
      (
        SELECT COUNT(*)::INTEGER FROM gacha_history gh
        WHERE gh.redeemed_at >= date_trunc('day', now())
      ) AS today_gacha,
      (
        SELECT COUNT(*)::INTEGER FROM gacha_history gh
        WHERE gh.redeemed_at >= now() - interval '7 days'
      ) AS week_gacha,
      (
        SELECT COUNT(*)::INTEGER FROM gacha_history gh
        WHERE gh.redeemed_at >= date_trunc('month', now())
      ) AS month_gacha
  `

  const rarityRows = await tx`
    SELECT c.rarity AS rarity, COUNT(*)::INTEGER AS draw_count
    FROM gacha_history gh
    JOIN cards c ON c.id = gh.card_id
    GROUP BY c.rarity
  `
  const rarityDistribution = Object.fromEntries(
    rarityRows.map((row) => [row.rarity, row.draw_count])
  )

  return {
    totalUsers: totals.total_users,
    totalStreamers: totals.total_streamers,
    totalCards: totals.total_cards,
    totalUserCards: totals.total_user_cards,
    usersWithTos: totals.users_with_tos,
    usersWithCards: totals.users_with_cards,
    totalGacha: totals.total_gacha,
    uniqueUsers: totals.unique_users,
    todayGacha: totals.today_gacha,
    weekGacha: totals.week_gacha,
    monthGacha: totals.month_gacha,
    rarityDistribution,
  }
}

/**
 * ダッシュボードが実際に呼ぶ `get_analysis_*()` RPCから同じ形の値を抽出する。
 * `fetchBasicAggregates` と同じ`tx`（`withReadOnlySnapshot`のcallback引数）で呼ぶこと。
 *
 * 4本のRPCは`Promise.all`で並行発行せず逐次`await`する（#1081 PR 2回目レビュー
 * 【任意】指摘: `max: 1`の単一接続・単一トランザクションでは`scripts/db-cutover/
 * layer-invariants.mjs`が明記するとおり並行発行しても直列実行されるだけで見た目上の
 * 並行化に意味が無い。逆に1文が失敗すると後続が`current transaction is aborted`に
 * なり、`permission denied for function`等の本来の原因が読み取りにくくなる副作用がある）。
 */
async function fetchRpcAggregates(tx) {
  const [overviewRow] = await tx`SELECT get_analysis_overview() AS result`
  const [usersSummaryRow] = await tx`SELECT get_analysis_users_summary() AS result`
  const [streamersSummaryRow] = await tx`SELECT get_analysis_streamers_summary() AS result`
  const [gachaTotalRow] = await tx`SELECT get_analysis_gacha_summary(NULL, NULL) AS result`

  const overview = overviewRow.result
  const usersSummary = usersSummaryRow.result
  const streamersSummary = streamersSummaryRow.result
  const gachaTotal = gachaTotalRow.result

  const rarityDistribution = Object.fromEntries(
    (gachaTotal.rarityDistribution ?? []).map((entry) => [entry.rarity, entry.value])
  )

  return {
    totalUsers: overview.stats.totalUsers,
    totalStreamers: overview.stats.totalStreamers,
    totalCards: overview.stats.totalCards,
    totalUserCards: usersSummary.totalCards,
    usersWithTos: usersSummary.usersWithTos,
    usersWithCards: usersSummary.usersWithCards,
    totalGacha: gachaTotal.totalGacha,
    uniqueUsers: gachaTotal.uniqueUsers,
    todayGacha: overview.stats.todayGacha,
    weekGacha: overview.stats.weekGacha,
    monthGacha: overview.stats.monthGacha,
    rarityDistribution,
    // usersSummary/streamersSummaryのtotalUsers・totalStreamers・totalCardsは
    // get_analysis_users_summary()/get_analysis_streamers_summary()という独立計算経路の
    // ため、overview.stats由来の値と別に併記して食い違いも検出する
    // （#1081 PR 2回目レビュー【任意】指摘: streamersSummaryだけ併記してusersSummaryを
    // 併記しないのは非対称だった）。
    usersSummaryTotalUsers: usersSummary.totalUsers,
    streamersSummaryTotalStreamers: streamersSummary.totalStreamers,
    streamersSummaryTotalCards: streamersSummary.totalCards,
  }
}

/**
 * 基礎集計RPC双方の数値を突き合わせ、不一致のリストを返す。DB接続なしで
 * 単体テストできるよう純粋関数として切り出す（verify-db-schema.jsのdiffSchemasと
 * 同じ方針）。
 *
 * scalarMetricsとstreamersSummary系はいずれも無条件で比較する（#1077 PR初版レビュー
 * 【必須】指摘: `rpc`側のキーが`undefined`のケース——例えば`get_analysis_streamers_summary()`
 * が将来`totalStreamers`を返さなくなる退行——を`!== undefined`ガードでスキップすると
 * 「RPC欠落を成功扱いにする」ことになり、docs/analysis-dashboard-db-permissions.mdの
 * 確認手順4「RPC 欠落...を成功扱いにしていないことを確認する」と矛盾する。ガード無しで
 * 常に比較すれば、欠落時は`expected: <値>, actual: undefined`という差分として報告される）。
 *
 * rarityDistributionはキー集合の和集合で比較し、片方にしか無いrarityは
 * もう片方を0として扱う。
 */
function diffAggregates(basic, rpc) {
  const diffs = []
  const scalarMetrics = [
    'totalUsers',
    'totalStreamers',
    'totalCards',
    'totalUserCards',
    'usersWithTos',
    'usersWithCards',
    'totalGacha',
    'uniqueUsers',
    'todayGacha',
    'weekGacha',
    'monthGacha',
  ]

  for (const metric of scalarMetrics) {
    if (basic[metric] !== rpc[metric]) {
      diffs.push({ metric, expected: basic[metric], actual: rpc[metric] })
    }
  }

  if (basic.totalUsers !== rpc.usersSummaryTotalUsers) {
    diffs.push({
      metric: 'usersSummary.totalUsers',
      expected: basic.totalUsers,
      actual: rpc.usersSummaryTotalUsers,
    })
  }

  if (basic.totalStreamers !== rpc.streamersSummaryTotalStreamers) {
    diffs.push({
      metric: 'streamersSummary.totalStreamers',
      expected: basic.totalStreamers,
      actual: rpc.streamersSummaryTotalStreamers,
    })
  }
  if (basic.totalCards !== rpc.streamersSummaryTotalCards) {
    diffs.push({
      metric: 'streamersSummary.totalCards',
      expected: basic.totalCards,
      actual: rpc.streamersSummaryTotalCards,
    })
  }

  const rarityKeys = new Set([
    ...Object.keys(basic.rarityDistribution ?? {}),
    ...Object.keys(rpc.rarityDistribution ?? {}),
  ])
  for (const rarity of rarityKeys) {
    const expected = basic.rarityDistribution?.[rarity] ?? 0
    const actual = rpc.rarityDistribution?.[rarity] ?? 0
    if (expected !== actual) {
      diffs.push({ metric: `rarityDistribution.${rarity}`, expected, actual })
    }
  }

  return diffs
}

// PostgreSQLがstatement_timeoutで文を強制キャンセルした際のSQLSTATE（query_canceled）。
// 57014はstatement_timeout以外（pg_cancel_backend等）でも使われるが、本スクリプトは
// 自分でtimeoutを設定した直後のクエリでしか使わないため、実質的にtimeout起因と同定できる。
const QUERY_CANCELED_SQLSTATE = '57014'

// PostgreSQLのGUC時間値として妥当な形式（例: '30s', '2min', '500ms'）。単位省略時は
// ミリ秒扱い（PostgreSQLの既定）。第1捕捉群（数値部分）を0判定に使う。
const STATEMENT_TIMEOUT_PATTERN = /^(\d+)(?:ms|s|min|h|d)?$/

/**
 * `get_analysis_gacha_summary(NULL, NULL)` の statement_timeout（本スクリプトの既定値は
 * 30秒。PostgreSQL自体の既定は無制限）を環境変数で上書きできるようにする
 * （production規模では全期間走査が既定の30秒を超えうり、その場合「不一致」ではなく
 * 「タイムアウト」なのに見分けがつきにくいため）。`tx.unsafe()` へそのまま埋め込むため、
 * PostgreSQLのGUC時間値として妥当な形式であることを検証してから返す（任意の文字列を
 * SQLへ混入させないための安全側の入力検証。DB接続なしで単体テストできるよう純粋関数
 * として切り出す）。
 *
 * `0`（またはそれと等価な"0ms"等）は明示的に拒否する。PostgreSQLはstatement_timeout=0を
 * 「無制限」として扱うため、これを許すと安全弁（想定外の長時間ブロック防止）が環境変数
 * だけで完全に無効化できてしまい、このタイムアウトを設ける意図と食い違う。
 */
function resolveStatementTimeout(env) {
  const raw = env.DASHBOARD_COMPARE_STATEMENT_TIMEOUT?.trim()
  if (!raw) return '30s'
  const match = STATEMENT_TIMEOUT_PATTERN.exec(raw)
  if (!match || Number(match[1]) === 0) {
    throw new Error(
      `DASHBOARD_COMPARE_STATEMENT_TIMEOUT の形式が不正です（0は無制限を意味するため拒否。例: "30s", "2min"）: "${raw}"`
    )
  }
  return raw
}

function printDiffTable(diffs) {
  const headers = ['METRIC', '基礎集計SQL', 'get_analysis_* RPC']
  const rows = diffs.map((d) => [d.metric, String(d.expected), String(d.actual)])
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')

  console.log(line(headers))
  console.log(line(widths.map((w) => '-'.repeat(w))))
  for (const row of rows) {
    console.log(line(row))
  }
}

function redactError(error, connectionString) {
  return core.redactSecretsFromText(
    error instanceof Error ? error.message : String(error),
    connectionString
  )
}

async function main() {
  const connectionString = resolveDashboardDatabaseUrl(process.env)
  if (!connectionString) {
    console.error(
      'Usage: DASHBOARD_DATABASE_URL="postgres://..." node scripts/compare-analysis-dashboard-vs-sql.mjs'
    )
    console.error('DASHBOARD_DATABASE_URL の設定が必要です。')
    console.error(
      '対象環境（preview/production）の限定readロール接続文字列を渡すこと（docs/analysis-dashboard-db-permissions.md参照）。'
    )
    process.exitCode = 2
    return
  }

  // postgres(...) の呼び出しも含めて全てtry内に置く（#1081 PR 2回目レビュー【必須】指摘:
  // 以前はpostgres(...)がtryの外にあり、接続文字列の形式不正等でここが同期的に
  // throwすると`main().catch`側の生の`console.error(error)`にそのまま渡っていた。
  // Node標準のURL解析エラー（ERR_INVALID_URL）は入力文字列自体をエラーオブジェクトの
  // プロパティとして保持するため、util.inspect経由でconsole.errorに渡すと接続文字列
  // （パスワード含む）がそのまま端末へ出てしまう。tryの内側に置くことで、この経路も
  // 下記catchのredactErrorを必ず通す）。
  let sql
  let exitCode = 0
  try {
    // 全期間のgacha_historyを走査する get_analysis_gacha_summary(NULL, NULL) は
    // ダッシュボードUIの既定（直近7日）より重いクエリになりうるため、想定外に長時間
    // ブロックしないよう安全弁を固定する（scripts/db-cutover/snapshot.mjsの
    // withRollbackOnlyTransactionと同じ理由・同じ方式）。production規模では既定値の
    // 30秒を超えうるため、DASHBOARD_COMPARE_STATEMENT_TIMEOUTで上書きできるようにする
    // （#1081 PR 2回目レビュー【任意】指摘）。不正な形式は接続前にfail fastする。
    const statementTimeout = resolveStatementTimeout(process.env)

    sql = postgres(core.stripPostgresJsIncompatibleSslParams(connectionString), {
      max: 1,
      connect_timeout: 15,
    })

    const diffs = await withReadOnlySnapshot(sql, async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = '${statementTimeout}'`)
      // 単一接続（max: 1）の単一トランザクション内では並行発行しても直列実行される
      // だけで意味が無く、1文の失敗が後続を`current transaction is aborted`にして
      // 本来のエラー原因を読み取りにくくする副作用があるため逐次awaitする
      // （#1081 PR 2回目レビュー【任意】指摘、scripts/db-cutover/layer-invariants.mjs
      // と同じ方針）。
      const basic = await fetchBasicAggregates(tx)
      const rpc = await fetchRpcAggregates(tx)
      return diffAggregates(basic, rpc)
    })

    if (diffs.length === 0) {
      console.log('OK: analysis dashboard の get_analysis_* RPC は基礎集計SQLと一致しました。')
    } else {
      console.log(`${diffs.length}件の不一致が見つかりました:\n`)
      printDiffTable(diffs)
      exitCode = 1
    }
  } catch (error) {
    const message = redactError(error, connectionString)
    const code =
      error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined

    console.error('analysis dashboard の集計比較に失敗しました:')
    if (code === QUERY_CANCELED_SQLSTATE) {
      // #1081 PR 2回目レビュー【任意】指摘: タイムアウトを「不一致」と混同しないよう
      // 明示的に区別する（RPCのバグではなく実行時間の問題であることを示す）。
      console.error(
        'クエリがタイムアウトしました（RPCの不一致ではなく実行時間の問題です）。DASHBOARD_COMPARE_STATEMENT_TIMEOUT で上限を延ばして再実行してください。'
      )
    }
    // postgres.jsのエラーはcode/detail/hintを持つ。「ロールにEXECUTEが無い」
    // 「RPC未適用」等の切り分けにcodeが有用なため付記する（#1081 PR 2回目レビュー
    // 【任意】指摘）。
    console.error(code ? `[${code}] ${message}` : message)
    exitCode = 2
  } finally {
    if (sql) {
      try {
        await sql.end({ timeout: 5 })
      } catch (error) {
        console.error('analysis dashboard のDB接続終了処理に失敗しました:')
        console.error(redactError(error, connectionString))
        // 比較自体は完了し不一致が見つかっていた場合（exitCode === 1）を、接続終了処理の
        // 失敗で上書きしない。「不一致あり」という結果は接続終了の成否と独立した事実であり、
        // 終了コードから判別できなくなると呼び出し元（CI/シェルスクリプト）が
        // 「不一致」と「クローズ失敗」を区別できなくなる。
        if (exitCode === 0) exitCode = 2
      }
    }
  }
  process.exitCode = exitCode
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // main内で接続文字列をredactできる経路はすべて処理する。ここは想定外の最終安全弁なので、
    // Errorオブジェクト自体（stackも含め）は出力せずcredential混入の可能性を排除する。
    // ただしSQLSTATE/Nodeエラーコード（error.code）は接続文字列を含まず切り分けに有用なため、
    // 存在すれば安全に付記する。
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
    console.error(
      code
        ? `analysis dashboard の集計比較で想定外のエラーが発生しました。[${code}]`
        : 'analysis dashboard の集計比較で想定外のエラーが発生しました。'
    )
    process.exitCode = 2
  })
}

export {
  resolveDashboardDatabaseUrl,
  resolveStatementTimeout,
  fetchBasicAggregates,
  fetchRpcAggregates,
  diffAggregates,
  printDiffTable,
}
