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

'use strict'

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
 */
async function fetchRpcAggregates(tx) {
  const [[overviewRow], [usersSummaryRow], [streamersSummaryRow], [gachaTotalRow]] =
    await Promise.all([
      tx`SELECT get_analysis_overview() AS result`,
      tx`SELECT get_analysis_users_summary() AS result`,
      tx`SELECT get_analysis_streamers_summary() AS result`,
      tx`SELECT get_analysis_gacha_summary(NULL, NULL) AS result`,
    ])

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
    // streamersSummaryのtotalStreamers/totalCardsはget_analysis_streamers_summary()の
    // 独立計算経路のため、overview.stats由来の値と別に併記して食い違いも検出する。
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

  const sql = postgres(core.stripPostgresJsIncompatibleSslParams(connectionString), {
    max: 1,
    connect_timeout: 15,
  })

  let exitCode = 0
  try {
    const diffs = await withReadOnlySnapshot(sql, async (tx) => {
      // 全期間のgacha_historyを走査する get_analysis_gacha_summary(NULL, NULL) は
      // ダッシュボードUIの既定（直近7日）より重いクエリになりうるため、検証スクリプトが
      // 想定外に長時間ブロックしないよう安全弁を固定する
      // （scripts/db-cutover/snapshot.mjsのwithRollbackOnlyTransactionと同じ理由・同じ方式）。
      await tx.unsafe(`SET LOCAL statement_timeout = '30s'`)
      const [basic, rpc] = await Promise.all([fetchBasicAggregates(tx), fetchRpcAggregates(tx)])
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
    const message = core.redactSecretsFromText(
      error instanceof Error ? error.message : String(error),
      connectionString
    )
    console.error('analysis dashboard の集計比較に失敗しました:')
    console.error(message)
    exitCode = 2
  } finally {
    await sql.end({ timeout: 5 })
  }
  process.exitCode = exitCode
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 2
  })
}

export { resolveDashboardDatabaseUrl, fetchBasicAggregates, fetchRpcAggregates, diffAggregates }
