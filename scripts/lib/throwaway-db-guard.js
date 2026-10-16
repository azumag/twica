'use strict'

/**
 * 「使い捨ての空DB」以外へ DDL を流してしまう事故を防ぐ純粋関数 (Issue #1665 Step 4)。
 *
 * 背景:
 *   tests/fixtures/chat-outbox-pending-kind-continuation-backfill-pg17.sh は baseline から
 *   スキーマを作って回帰を再現する。その最初の DDL である
 *   db/planetscale/migrations/20260719180000_planetscale_bootstrap.sql は
 *   `CREATE OR REPLACE FUNCTION auth.uid() / auth.jwt() / auth.role()` を NULL/固定値スタブへ
 *   置き換える（#568 の既定路線）。したがって既存DB（本番/preview/別用途のDB）を誤って指定すると、
 *   本物の認可関数をスタブへ置き換えてしまう。
 *
 *   さらに bootstrap は独立した transaction で commit されるため、後続の baseline が既存
 *   オブジェクトとの衝突で失敗しても、この置き換えは rollback されない。つまり
 *   「outbox と migration 履歴が無いこと」だけを確認するガードでは不十分で、既存の
 *   `public.users` だけがあるDBや `auth` 関数だけがあるDBを通してしまう。
 *
 * 役割:
 *   呼び出し側（fixture）が **最初の DDL より前に** DB から収集した在庫を渡し、本関数が
 *   fail-closed に可否を判定する。収集結果が欠けている/壊れている場合も「拒否」に倒す
 *   （取得失敗を「空DB」と誤認しない）。
 *
 * @param {unknown} inventory
 *   `{ schemas: string[], relations: string[], routines: string[] }`
 *   - schemas:   public / pg_catalog / information_schema / pg_toast / pg_temp* 以外の schema 名
 *   - relations: 非 system schema にある relation（table/view/matview/sequence/foreign table）
 *   - routines:  非 system schema にある routine（function/procedure）
 * @returns {{ ok: boolean, reasons: string[] }}
 */
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast'])
// public は CREATE DATABASE 直後から必ず存在するため「schema の存在」だけでは拒否しない。
// ただし public の中に relation / routine があれば拒否する（既存の利用者がいるDB）。
const ALWAYS_PRESENT_SCHEMAS = new Set(['public'])

const REQUIRED_KEYS = ['schemas', 'relations', 'routines']

function isTempSchema(name) {
  return name.startsWith('pg_temp') || name.startsWith('pg_toast_temp')
}

function summarize(names) {
  if (names.length <= 5) return names.join(', ')
  return `${names.slice(0, 5).join(', ')} ほか${names.length - 5}件`
}

function assessThrowawayDatabase(inventory) {
  if (inventory === null || typeof inventory !== 'object') {
    return {
      ok: false,
      reasons: ['対象DBの状態を取得できませんでした（取得失敗を空DBと誤認しないため拒否します）'],
    }
  }

  const missing = REQUIRED_KEYS.filter((key) => !Array.isArray(inventory[key]))
  if (missing.length > 0) {
    return {
      ok: false,
      reasons: [`対象DBの状態が不完全です（${missing.join(', ')}）。fail-closed で拒否します`],
    }
  }

  const reasons = []
  const unexpectedSchemas = inventory.schemas.filter(
    (name) =>
      typeof name === 'string' &&
      name.length > 0 &&
      !SYSTEM_SCHEMAS.has(name) &&
      !ALWAYS_PRESENT_SCHEMAS.has(name) &&
      !isTempSchema(name),
  )
  if (unexpectedSchemas.length > 0) {
    reasons.push(`非 system schema が存在します: ${summarize(unexpectedSchemas)}`)
  }
  if (inventory.relations.length > 0) {
    reasons.push(`非 system schema に既存の relation があります: ${summarize(inventory.relations)}`)
  }
  if (inventory.routines.length > 0) {
    reasons.push(`非 system schema に既存の routine があります: ${summarize(inventory.routines)}`)
  }

  return { ok: reasons.length === 0, reasons }
}

module.exports = {
  assessThrowawayDatabase,
  SYSTEM_SCHEMAS,
  ALWAYS_PRESENT_SCHEMAS,
}
