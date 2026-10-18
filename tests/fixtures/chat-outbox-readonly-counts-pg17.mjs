/**
 * db-readonly-check(-production).yml の集計 SQL に対する回帰 (Issue #1665 Step 4)。
 *
 * 対象 workflow は第1引数で切り替える（既定は preview 用）。production 用
 * (.github/workflows/db-readonly-check-production.yml) も同じ SQL を持つため、
 * main の CI では production 側を指定して実 PG17 で検証する。
 *
 * 背景（レビュー指摘 P2）:
 *   集計 SQL の `targets_total` が `status='pending' OR status='processing'` を前置フィルタに
 *   持つだけでは、**有効 lease 中の processing 行**まで数えてしまう。補正 migration
 *   20261018010000 の UPDATE は `lease_expires_at <= now()` の processing 行しか触らないため、
 *   「20261018010000 と同一の predicate」という説明と実際の数がずれ、残件0の判定を誤らせる。
 *
 * この fixture が固定するもの:
 *   1. workflow から**集計 SQL をそのまま取り出して**実行する（テスト側に predicate を写さない）
 *   2. 有効 lease 中の processing 行を数えないこと
 *   3. `targets_total = targets_pending + targets_processing_lease_expired`（合計 = 内訳和）
 *   4. 合計が、補正 UPDATE が実際に変更する行数と一致すること（独立に用意した仕様 predicate で照合）
 *
 * npm 依存は使わない（migration job には npm ci が無い）。psql と node の標準モジュールだけを使う。
 * 使い捨ての DB（migration 適用済み）に対して実行し、投入した行は最後に削除する。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PSQL_ARGS = [
  '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-h', process.env.PGHOST || '127.0.0.1',
  '-p', process.env.PGPORT || '5432',
  '-U', process.env.PGUSER || 'postgres',
  '-d', process.env.PGDATABASE || 'postgres',
]
const psql = (input) => execFileSync('psql', PSQL_ARGS, { input, encoding: 'utf8' })

/** YAML の block scalar から、指定 step の heredoc 本体を取り出す（依存パッケージを使わない）。 */
function extractHeredoc(workflowText, stepName) {
  const lines = workflowText.split('\n')
  const stepIndex = lines.findIndex((line) => line.includes(`- name: ${stepName}`))
  assert.ok(stepIndex >= 0, `step "${stepName}" が workflow に見つかりません`)
  const heredocRel = lines.slice(stepIndex).findIndex((line) => line.includes("<<'SQL'"))
  assert.ok(heredocRel >= 0, `step "${stepName}" に <<'SQL' heredoc がありません`)
  const bodyStart = stepIndex + heredocRel + 1
  let bodyEnd = bodyStart
  while (bodyEnd < lines.length && !/^\s*SQL\s*$/.test(lines[bodyEnd])) bodyEnd += 1
  assert.ok(bodyEnd < lines.length, 'heredoc の終端 SQL が見つかりません')
  const body = lines.slice(bodyStart, bodyEnd)
  const indents = body.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length)
  const indent = Math.min(...indents)
  return body.map((line) => line.slice(indent)).join('\n')
}

// 検証対象の workflow。引数が無ければ preview 用（preview 側の CI と同じ既定）。
const WORKFLOW_PATH = process.argv[2] || '.github/workflows/db-readonly-check.yml'
const workflowText = readFileSync(WORKFLOW_PATH, 'utf8')
const countsSql = extractHeredoc(workflowText, 'Count backfill targets (read-only)')
assert.ok(
  countsSql.includes('targets_total'),
  '取り出した SQL に targets_total がありません（workflow の構造が変わった可能性）',
)

const PREFIX = 'rocheck-'
const cleanup = () => psql(`DELETE FROM public.chat_notification_outbox WHERE batch_id LIKE '${PREFIX}%';`)

try {
  cleanup()

  // ケース行列: 対象になるのは pending 2 行 + lease 失効 processing 1 行の計 3 行。
  // 有効 lease 中の processing 行（bug の元）は対象外でなければならない。
  psql(`
INSERT INTO public.chat_notification_outbox
  (batch_id, payload, expected_draw_count, assembled_draw_count, status, next_attempt_at)
VALUES
  ('${PREFIX}pending-partial-a',  '{}'::jsonb, 12, 12, 'pending', now()),
  ('${PREFIX}pending-partial-b',  '{}'::jsonb, 12, 12, 'pending', now()),
  ('${PREFIX}processing-expired', '{}'::jsonb, 12, 12, 'pending', now()),
  ('${PREFIX}processing-active',  '{}'::jsonb, 12, 12, 'pending', now()),
  ('${PREFIX}pending-cursor0',    '{}'::jsonb, 12, 12, 'pending', now()),
  ('${PREFIX}pending-complete',   '{}'::jsonb, 12, 12, 'pending', now()),
  ('${PREFIX}pending-retry',      '{}'::jsonb, 12, 12, 'pending', now()),
  ('${PREFIX}sent-partial',       '{}'::jsonb, 12, 12, 'pending', now());
UPDATE public.chat_notification_outbox SET delivery_cursor = 5
  WHERE batch_id IN ('${PREFIX}pending-partial-a','${PREFIX}pending-partial-b','${PREFIX}processing-expired',
                     '${PREFIX}processing-active','${PREFIX}pending-retry','${PREFIX}sent-partial');
UPDATE public.chat_notification_outbox SET delivery_cursor = 12 WHERE batch_id = '${PREFIX}pending-complete';
UPDATE public.chat_notification_outbox SET pending_kind = 'retry' WHERE batch_id = '${PREFIX}pending-retry';
UPDATE public.chat_notification_outbox
  SET status = 'processing', lease_id = gen_random_uuid(), lease_expires_at = now() - interval '1 minute'
  WHERE batch_id = '${PREFIX}processing-expired';
UPDATE public.chat_notification_outbox
  SET status = 'processing', lease_id = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes'
  WHERE batch_id = '${PREFIX}processing-active';
UPDATE public.chat_notification_outbox SET status = 'sent', sent_at = now() WHERE batch_id = '${PREFIX}sent-partial';
`)

  // 1. workflow の集計 SQL をそのまま実行し、targets 行を取り出す。
  const output = psql(countsSql)
  const targetsRow = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.split('|').length === 5 && line.split('|').slice(1).every((v) => /^\d+$/.test(v)))
  assert.ok(targetsRow, `集計 SQL の targets 行を出力から特定できませんでした:\n${output}`)
  const [, total, pending, expired] = targetsRow.split('|').map((v) => Number(v))

  // 2. 有効 lease 中の processing 行を数えていないこと（レビュー指摘の本体）。
  const activeLeaseCounted = Number(
    psql(`
SELECT count(*) FROM public.chat_notification_outbox
WHERE batch_id = '${PREFIX}processing-active'
  AND delivery_cursor > 0 AND delivery_cursor < expected_draw_count AND pending_kind = 'initial';
`).trim(),
  )
  assert.equal(activeLeaseCounted, 1, '前提が壊れています（有効 lease 行が補正対象の形になっていない）')

  // 3. 合計 = 内訳和。
  assert.equal(total, pending + expired, `targets_total(${total}) != pending(${pending}) + expired(${expired})`)

  // 4. 期待値（仕様 predicate から独立に数えた値）。
  assert.equal(total, 3, `targets_total は 3 を期待（pending 2 + lease失効 processing 1）。実際 ${total}`)
  assert.equal(pending, 2, `targets_pending は 2 を期待。実際 ${pending}`)
  assert.equal(expired, 1, `targets_processing_lease_expired は 1 を期待。実際 ${expired}`)

  // 5. 合計が「補正 UPDATE が実際に変更する行数」と一致すること。
  //    transaction 内で実行して count を取り、ROLLBACK する（他行を変更しない）。
  const affectedRaw = psql(`
BEGIN;
WITH bumped AS (
  UPDATE public.chat_notification_outbox
  SET pending_kind = 'continuation', updated_at = now()
  WHERE (status = 'pending' OR (status = 'processing' AND lease_expires_at <= now()))
    AND delivery_cursor > 0
    AND delivery_cursor < expected_draw_count
    AND pending_kind = 'initial'
  RETURNING 1
)
SELECT count(*) FROM bumped;
ROLLBACK;
`)
  const affected = Number(
    affectedRaw.split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).pop(),
  )
  assert.equal(
    affected,
    total,
    `補正 UPDATE が変更する行数(${affected}) と workflow が報告する targets_total(${total}) が一致しません`,
  )

  console.log(
    `OK  readonly-counts (${WORKFLOW_PATH}): targets_total=${total} pending=${pending} lease_expired=${expired} update_affected=${affected}`,
  )
} finally {
  cleanup()
}
