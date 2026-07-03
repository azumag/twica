#!/usr/bin/env node

/**
 * デプロイ後スモークテスト / Post-deploy smoke check (#536)
 *
 * 背景:
 * Cloudflare Workers Builds は GitHub Actions とは独立して Git push をトリガーに
 * アプリをデプロイする。Supabase マイグレーションは GitHub Actions
 * (.github/workflows/deploy-cloudflare.yml) が別途 `supabase db push` で適用するため、
 * 両者の実行タイミングが完全に同期している保証がない。#525-527 の本番障害は、
 * コードが参照する列・関数がまだマイグレーション未適用のDBに対して実行され、
 * 500エラーやガチャ機能全停止を引き起こしたことが原因だった。
 *
 * このアーキテクチャでは「マイグレーション成功を条件にデプロイをブロックする」
 * 真のデプロイゲートは実現できない(#536 で検討済み、既存の Cloudflare Workers
 * Builds 連携を崩さずに実現する方法がないため見送り)。代わりに、デプロイ後
 * (最大15分以内)に本番の主要ページとDBスキーマの整合性を定期チェックし、
 * 異常があれば GitHub Issue でアラートする「検知して知らせる」方式を採用する。
 * これはデプロイを止める・ロールバックするものではない (ALERTのみ)。
 *
 * チェック内容:
 *   1. 主要ページが 2xx を返すか (HTTPスモークテスト)
 *   2. 直近の数マイグレーションが追加した列・テーブルが実在するか
 *      (これが #525-527 と同型の「コードは新列を前提にしているが
 *      マイグレーションが本番に未適用」を検知する最も高シグナルなチェック)
 *
 * 使い方:
 *   node scripts/smoke-check.js
 *   npm run smoke-check
 *   SMOKE_TEST_BASE_URL=https://twica-preview.example.workers.dev npm run smoke-check
 *
 * 必要な環境変数:
 *   - SMOKE_TEST_BASE_URL (任意): チェック対象のベースURL。省略時は本番URL。
 *   - NEXT_PUBLIC_SUPABASE_URL: SupabaseプロジェクトURL (DBスキーマチェックに必要)
 *   - SUPABASE_SECRET_KEY または SUPABASE_SERVICE_ROLE_KEY: Supabase管理者キー
 *     (DBスキーマチェックに必要。未設定の場合はDBチェックを失敗として報告する)
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createClient } = require('@supabase/supabase-js')

/** SMOKE_TEST_BASE_URL 未設定時に使うデフォルトの本番URL */
const DEFAULT_BASE_URL = 'https://twica.bluemoon.works'

/** HTTPスモークテスト対象のパス一覧 (2xxを期待する主要ページ) */
const SMOKE_TEST_PATHS = ['/', '/plans']

/**
 * DBスキーマ整合性チェック対象一覧。
 *
 * 「直近の数マイグレーションが追加した列・テーブル」を優先して選ぶ方針
 * (#536 の設計判断): 全カラムを網羅するのではなく、#525-527 と同型の
 * 「コードが新しいスキーマを前提にしているが、そのマイグレーションが
 * 本番にまだ適用されていない」事故を検知する上で最もシグナルの強い、
 * 最新のマイグレーションが追加した列・テーブルだけを対象にする。
 *
 * column が null の場合はテーブル自体の存在確認のみ行う。
 */
const SCHEMA_CHECKS = [
  // 00067_add_card_issuance_limits.sql
  { table: 'cards', column: 'max_issuance_count' },
  // 00065_add_pack_rarity_weights.sql
  { table: 'streamers', column: 'pack_rarity_weights' },
  { table: 'streamers', column: 'rarity_weights_scope' },
  // 00066_add_gacha_sound_rules.sql
  { table: 'streamers', column: 'gacha_sound_rules' },
  // ガチャ抽選履歴テーブル自体の存在確認 (最も基礎的なテーブル)
  { table: 'gacha_history', column: null },
]

/**
 * env オブジェクトからチェック対象のベースURLを解決する純粋関数。
 * 末尾のスラッシュは正規化のため除去する。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function resolveBaseUrl(env) {
  const raw = env.SMOKE_TEST_BASE_URL
  if (raw && raw.trim()) {
    return raw.trim().replace(/\/+$/, '')
  }
  return DEFAULT_BASE_URL
}

/**
 * ベースURLとパス一覧から、チェック対象の完全なURL一覧を組み立てる純粋関数。
 *
 * @param {string} baseUrl
 * @param {string[]} paths
 * @returns {string[]}
 */
function buildCheckUrls(baseUrl, paths) {
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  return paths.map((p) => `${trimmedBase}${p.startsWith('/') ? p : `/${p}`}`)
}

/**
 * URLチェック失敗時の説明メッセージを組み立てる純粋関数。
 * error があればネットワークエラー、なければステータスコード異常として報告する。
 *
 * @param {{ status?: number, error?: unknown }} info
 * @returns {string}
 */
function formatUrlCheckFailure({ status, error }) {
  if (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `HTTPリクエストが失敗しました (${message})`
  }
  return `期待した2xxではなく ${status} が返却されました`
}

/**
 * table/column のラベル文字列を組み立てる純粋関数 (テーブルのみの場合は "(table)" と表記)。
 *
 * @param {{ table: string, column: string | null }} entry
 * @returns {string}
 */
function schemaEntryLabel(entry) {
  return entry.column ? `${entry.table}.${entry.column}` : `${entry.table} (table)`
}

/**
 * DBスキーマチェック失敗時の説明メッセージを組み立てる純粋関数。
 *
 * @param {{ table: string, column: string | null, error: { code?: string, message?: string } }} info
 * @returns {string}
 */
function formatSchemaCheckFailure({ table, column, error }) {
  const target = schemaEntryLabel({ table, column })
  const code = error && error.code ? error.code : 'unknown'
  const message = error && error.message ? error.message : String(error)
  return `${target} の存在確認に失敗しました (code=${code}, message=${message})`
}

/**
 * PostgREST/PostgreSQL が返す「テーブル・列が存在しない」系エラーかどうかを判定する純粋関数。
 *
 * 既存コード (src/lib/collections/collection-existence.ts の
 * isMissingCollectionNameColumn 等、src/lib/twitch/token-manager.ts の
 * isMissingBotSchemaError) と同じ判定慣習を踏襲する:
 *   - 42703: PostgreSQL の undefined_column (SELECT等の読み取りパスで発生)
 *   - 42P01: PostgreSQL の undefined_table
 *   - PGRST204: PostgRESTのスキーマキャッシュに列が見つからない (書き込みパスで発生しやすい)
 *   - PGRST205: PostgRESTのスキーマキャッシュにテーブルが見つからない
 *   - メッセージ本文に "does not exist" / "schema cache" を含む場合も同様に扱う
 * このスクリプトは対象の table/column を自分で指定してSELECTするため、
 * 既存コードのような「列名で結果をゲートする」処理は不要 (誤検知の余地がない)。
 *
 * @param {{ code?: string, message?: string, details?: string, hint?: string } | null | undefined} error
 * @returns {boolean}
 */
function isSchemaMissingError(error) {
  if (!error || typeof error !== 'object') return false

  const text = [error.message, error.details, error.hint]
    .map((value) => String(value || ''))
    .join(' ')

  return (
    error.code === '42703' ||
    error.code === '42P01' ||
    error.code === 'PGRST204' ||
    error.code === 'PGRST205' ||
    text.includes('does not exist') ||
    text.includes('schema cache')
  )
}

/**
 * 個々のチェック結果 (URL/DBスキーマ共通の形) から、成否のサマリメッセージを組み立てる純粋関数。
 *
 * @param {Array<{ ok: boolean, name: string, detail?: string }>} results
 * @returns {{ ok: boolean, message: string }}
 */
function summarizeResults(results) {
  const failures = results.filter((r) => !r.ok)

  if (failures.length > 0) {
    const lines = [
      `[smoke-check] NG: ${failures.length}/${results.length} 件のチェックに失敗しました:`,
      '',
      ...failures.map((f) => `  - ${f.name}: ${f.detail || '不明なエラー'}`),
    ]
    return { ok: false, message: lines.join('\n') }
  }

  return {
    ok: true,
    message: `[smoke-check] OK: ${results.length} 件のチェックに全て成功しました`,
  }
}

/** 1つのURLに GET リクエストを送り、2xx かどうかを確認する (ネットワークI/Oあり、単体テスト対象外)。 */
async function checkUrlEntry(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (res.ok) {
      return { ok: true, name: `GET ${url}` }
    }
    return { ok: false, name: `GET ${url}`, detail: formatUrlCheckFailure({ status: res.status }) }
  } catch (error) {
    return { ok: false, name: `GET ${url}`, detail: formatUrlCheckFailure({ error }) }
  }
}

/**
 * 1つの table/column の存在確認を行う (DB I/Oあり、単体テスト対象外)。
 * 対象列 (またはテーブル丸ごとの場合は "*") を limit(1) で1件だけ読み取り、
 * 列/テーブル不在エラーを isSchemaMissingError で判定する。
 */
async function checkSchemaEntry(supabase, entry) {
  const label = schemaEntryLabel(entry)
  const selectExpr = entry.column || '*'

  try {
    const { error } = await supabase.from(entry.table).select(selectExpr).limit(1)

    if (error) {
      if (isSchemaMissingError(error)) {
        return { ok: false, name: label, detail: formatSchemaCheckFailure({ ...entry, error }) }
      }
      // スキーマ不在以外の予期しないDBエラー (権限エラー等) も失敗として報告する。
      return {
        ok: false,
        name: label,
        detail: `予期しないDBエラー (code=${error.code || 'unknown'}, message=${error.message})`,
      }
    }

    return { ok: true, name: label }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, name: label, detail: `例外が発生しました (${message})` }
  }
}

/**
 * env から Supabase 管理者クライアントを組み立てる。
 * SUPABASE_SECRET_KEY (新名称) / SUPABASE_SERVICE_ROLE_KEY (レガシー名称) の
 * どちらでも動くようにする (src/lib/env-validation.ts の requiredEnvVarGroups と同じ方針)。
 *
 * @returns {{ client: import('@supabase/supabase-js').SupabaseClient | null, missing: string[] }}
 */
function buildSupabaseAdmin(env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
  const missing = []

  if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!key) missing.push('SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)')

  if (missing.length > 0) {
    return { client: null, missing }
  }

  return { client: createClient(url, key), missing: [] }
}

async function main() {
  const baseUrl = resolveBaseUrl(process.env)
  const urls = buildCheckUrls(baseUrl, SMOKE_TEST_PATHS)

  console.log(`[smoke-check] 対象URL: ${baseUrl}`)

  const urlResults = await Promise.all(urls.map((url) => checkUrlEntry(url)))

  const { client: supabase, missing } = buildSupabaseAdmin(process.env)

  let schemaResults
  if (!supabase) {
    // DBスキーマチェックに必要な環境変数が無い場合、チェックをスキップせず
    // 明示的な失敗として報告する (本番運用ではこの環境変数は必ず設定されているべきで、
    // 未設定のまま「チェック省略」を成功扱いにすると設定ミスを検知できなくなるため)。
    schemaResults = [
      {
        ok: false,
        name: 'schema-checks',
        detail: `DBスキーマチェックに必要な環境変数が未設定です: ${missing.join(', ')}`,
      },
    ]
  } else {
    schemaResults = await Promise.all(SCHEMA_CHECKS.map((entry) => checkSchemaEntry(supabase, entry)))
  }

  const summary = summarizeResults([...urlResults, ...schemaResults])

  if (!summary.ok) {
    console.error(summary.message)
    process.exit(1)
  }

  console.log(summary.message)
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[smoke-check] 予期しない例外で終了しました:', error)
    process.exit(1)
  })
}

module.exports = {
  resolveBaseUrl,
  buildCheckUrls,
  formatUrlCheckFailure,
  schemaEntryLabel,
  formatSchemaCheckFailure,
  isSchemaMissingError,
  summarizeResults,
  SMOKE_TEST_PATHS,
  SCHEMA_CHECKS,
  DEFAULT_BASE_URL,
}
