#!/usr/bin/env node
'use strict'

/**
 * Post-deploy smoke check (#536)
 *
 * Cloudflare Workers Builds and database migrations are separate workflows, so
 * this job checks both public HTTP availability and the authoritative
 * PlanetScale schema every 15 minutes. It does not block or roll back a deploy;
 * the scheduled workflow files/updates an incident issue on failure.
 *
 * Environment:
 *   - SMOKE_TEST_BASE_URL (optional)
 *   - PLANETSCALE_DATABASE_URL, DATABASE_URL, or DATABASE_URL_PLANETSCALE
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const postgres = require('postgres')

const DEFAULT_BASE_URL = 'https://twica.bluemoon.works'
const SMOKE_TEST_PATHS = ['/', '/plans']

const SCHEMA_CHECKS = [
  { table: 'cards', column: 'max_issuance_count' },
  { table: 'streamers', column: 'pack_rarity_weights' },
  { table: 'streamers', column: 'rarity_weights_scope' },
  { table: 'streamers', column: 'gacha_sound_rules' },
  { table: 'gacha_history', column: null },
]

function resolveBaseUrl(env) {
  const raw = env.SMOKE_TEST_BASE_URL
  if (raw && raw.trim()) return raw.trim().replace(/\/+$/, '')
  return DEFAULT_BASE_URL
}

function buildCheckUrls(baseUrl, paths) {
  const trimmedBase = baseUrl.replace(/\/+$/, '')
  return paths.map((entry) => `${trimmedBase}${entry.startsWith('/') ? entry : `/${entry}`}`)
}

/** @param {{ status?: number, error?: unknown }} input */
function formatUrlCheckFailure({ status, error }) {
  if (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `HTTPリクエストが失敗しました (${message})`
  }
  return `期待した2xxではなく ${status} が返却されました`
}

function schemaEntryLabel(entry) {
  return entry.column ? `${entry.table}.${entry.column}` : `${entry.table} (table)`
}

function formatSchemaCheckFailure({ table, column, error }) {
  const target = schemaEntryLabel({ table, column })
  const code = error && error.code ? error.code : 'unknown'
  const message = error && error.message ? error.message : String(error)
  return `${target} の存在確認に失敗しました (code=${code}, message=${message})`
}

/**
 * PlanetScale PostgreSQL の schema 欠落を SQLSTATE と標準メッセージで検知する。
 * HTTP API 固有の互換コードを受理すると退役経路の再導入を見逃すため、
 * 現行ドライバーが返す 42703/42P01 だけをコード判定する。
 */
function isSchemaMissingError(error) {
  if (!error || typeof error !== 'object') return false
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value || ''))
    .join(' ')

  return (
    error.code === '42703' ||
    error.code === '42P01' ||
    text.includes('does not exist') ||
    text.includes('undefined column') ||
    text.includes('undefined table')
  )
}

function summarizeResults(results) {
  const failures = results.filter((result) => !result.ok)
  if (failures.length > 0) {
    const lines = [
      `[smoke-check] NG: ${failures.length}/${results.length} 件のチェックに失敗しました:`,
      '',
      ...failures.map((failure) => `  - ${failure.name}: ${failure.detail || '不明なエラー'}`),
    ]
    return { ok: false, message: lines.join('\n') }
  }

  return {
    ok: true,
    message: `[smoke-check] OK: ${results.length} 件のチェックに全て成功しました`,
  }
}

async function checkUrlEntry(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (response.ok) return { ok: true, name: `GET ${url}` }
    return {
      ok: false,
      name: `GET ${url}`,
      detail: formatUrlCheckFailure({ status: response.status }),
    }
  } catch (error) {
    return { ok: false, name: `GET ${url}`, detail: formatUrlCheckFailure({ error }) }
  }
}

function resolveDatabaseUrl(env) {
  const value =
    env.PLANETSCALE_DATABASE_URL ||
    env.DATABASE_URL ||
    env.DATABASE_URL_PLANETSCALE
  return value && value.trim() ? value.trim() : null
}

/**
 * Check table/column existence through parameterized information_schema reads.
 * No table or column identifier is interpolated into executable SQL.
 */
async function checkSchemaEntry(sql, entry) {
  const label = schemaEntryLabel(entry)
  try {
    const rows = entry.column
      ? await sql`
          select exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = ${entry.table}
              and column_name = ${entry.column}
          ) as exists
        `
      : await sql`
          select exists (
            select 1
            from information_schema.tables
            where table_schema = 'public'
              and table_name = ${entry.table}
          ) as exists
        `

    if (rows[0]?.exists === true) return { ok: true, name: label }

    const error = {
      code: entry.column ? '42703' : '42P01',
      message: `${label} does not exist in PlanetScale public schema`,
    }
    return {
      ok: false,
      name: label,
      detail: formatSchemaCheckFailure({ ...entry, error }),
    }
  } catch (error) {
    const normalized = {
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    }
    return {
      ok: false,
      name: label,
      detail: formatSchemaCheckFailure({ ...entry, error: normalized }),
    }
  }
}

async function main() {
  const baseUrl = resolveBaseUrl(process.env)
  const urls = buildCheckUrls(baseUrl, SMOKE_TEST_PATHS)
  console.log(`[smoke-check] 対象URL: ${baseUrl}`)

  const urlResults = await Promise.all(urls.map((url) => checkUrlEntry(url)))
  const databaseUrl = resolveDatabaseUrl(process.env)

  let schemaResults
  if (!databaseUrl) {
    schemaResults = [{
      ok: false,
      name: 'schema-checks',
      detail: 'PlanetScale schema check requires PLANETSCALE_DATABASE_URL, DATABASE_URL, or DATABASE_URL_PLANETSCALE',
    }]
  } else {
    const sql = postgres(databaseUrl, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 10,
      prepare: false,
    })
    try {
      schemaResults = await Promise.all(
        SCHEMA_CHECKS.map((entry) => checkSchemaEntry(sql, entry))
      )
    } finally {
      await sql.end({ timeout: 5 })
    }
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
  resolveDatabaseUrl,
  checkSchemaEntry,
  SMOKE_TEST_PATHS,
  SCHEMA_CHECKS,
  DEFAULT_BASE_URL,
}
