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
 * 使い方:
 *   DASHBOARD_DATABASE_URL="postgres://..." node scripts/compare-analysis-dashboard-vs-sql.js
 *   （`DASHBOARD_DATABASE_URL` が無い場合は `DATABASE_URL_PLANETSCALE`、
 *    `PLANETSCALE_DATABASE_URL` の順にフォールバックする。#1077 Issueが列挙した
 *    3つの環境変数名と揃えてある。preview / production の限定readロール接続文字列を
 *    渡すこと。DB接続が必要なためCIでは実行しない）
 *
 * 出力上の注意:
 *   差分調査のためその場でターミナルへ数値を表示する。この出力をIssue/PR/ログへ
 *   恒久的に転記しない（CLAUDE.mdのredaction方針、docs/QA.mdの証拠redaction方針と
 *   同じ理由）。
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./lib/db-migrate-core')

/**
 * #1077 Issue本文が列挙した3つの環境変数名を優先順に解決する。
 * `DASHBOARD_DATABASE_URL` が `analysis/dev/adminApiPg.ts` の正本契約のため最優先。
 */
function resolveConnectionString(env) {
  return (
    env.DASHBOARD_DATABASE_URL?.trim() ||
    env.DATABASE_URL_PLANETSCALE?.trim() ||
    env.PLANETSCALE_DATABASE_URL?.trim() ||
    ''
  )
}

/**
 * `get_analysis_*()` RPCを経由しない基礎集計。RPC定義
 * （00073_add_analysis_dashboard_rpcs.sql の get_analysis_overview /
 *   get_analysis_gacha_summary、20260731120000_paginate_analysis_dashboard.sql の
 *   get_analysis_users_summary / get_analysis_streamers_summary）と同じ境界定義
 *  （today = date_trunc('day', now())、week = now() - interval '7 days'、
 *   month = date_trunc('month', now())）を独立に書き下す。
 *
 * rarityDistributionは配列のため、この関数では { [rarity]: count } のオブジェクトに
 * 変換してRPC側と比較しやすくする。
 */
async function fetchBasicAggregates(sql) {
  const [totals] = await sql`
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

  const rarityRows = await sql`
    SELECT c.rarity AS rarity, COUNT(*)::INTEGER AS draw_count
    FROM gacha_history gh
    JOIN cards c ON c.id = gh.card_id
    GROUP BY c.rarity
    HAVING COUNT(*) > 0
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

/** ダッシュボードが実際に呼ぶ `get_analysis_*()` RPCから同じ形の値を抽出する。 */
async function fetchRpcAggregates(sql) {
  const [[overviewRow], [usersSummaryRow], [streamersSummaryRow], [gachaTotalRow]] =
    await Promise.all([
      sql`SELECT get_analysis_overview() AS result`,
      sql`SELECT get_analysis_users_summary() AS result`,
      sql`SELECT get_analysis_streamers_summary() AS result`,
      sql`SELECT get_analysis_gacha_summary(NULL, NULL) AS result`,
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
 * rarityDistributionはキー集合の和集合で比較し、片方にしか無いrarityは
 * もう片方を0として扱う（0件のrarityはRPC側で`HAVING COUNT(*) > 0`により
 * 配列に現れないため、この基礎集計側も同じ条件でフィルタ済み。両者とも
 * 出現しないキーは比較対象にならない）。
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

  if (rpc.streamersSummaryTotalStreamers !== undefined) {
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
  const connectionString = resolveConnectionString(process.env)
  if (!connectionString) {
    console.error(
      'Usage: DASHBOARD_DATABASE_URL="postgres://..." node scripts/compare-analysis-dashboard-vs-sql.js'
    )
    console.error(
      'None of DASHBOARD_DATABASE_URL, DATABASE_URL_PLANETSCALE, PLANETSCALE_DATABASE_URL is set.'
    )
    console.error(
      'Use a preview- or production-scoped limited read role connection string (see docs/analysis-dashboard-db-permissions.md).'
    )
    process.exit(2)
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const postgres = require('postgres')
  const sql = postgres(core.stripPostgresJsIncompatibleSslParams(connectionString), {
    max: 1,
    connect_timeout: 15,
  })

  let exitCode = 0
  try {
    const [basic, rpc] = await Promise.all([fetchBasicAggregates(sql), fetchRpcAggregates(sql)])
    const diffs = diffAggregates(basic, rpc)

    if (diffs.length === 0) {
      console.log(
        'OK: analysis dashboard の get_analysis_* RPC は基礎集計SQLと一致しました。'
      )
    } else {
      console.error(`\n${diffs.length}件の不一致が見つかりました:\n`)
      printDiffTable(diffs)
      exitCode = 1
    }
  } catch (error) {
    console.error('analysis dashboard の集計比較に失敗しました:')
    console.error(error instanceof Error ? error.message : error)
    exitCode = 2
  } finally {
    await sql.end({ timeout: 5 })
  }
  process.exit(exitCode)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}

module.exports = {
  resolveConnectionString,
  fetchBasicAggregates,
  fetchRpcAggregates,
  diffAggregates,
}
