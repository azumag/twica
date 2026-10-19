/**
 * chat-outbox-watch.yml（Issue #1837 の chat outbox 滞留 watchdog）に対する回帰。
 *
 * 対象は2つ:
 *   1. 「Observe outbox stagnation metrics (read-only)」step に埋め込んだ観測 SQL
 *   2. 「Evaluate alert conditions」step に埋め込んだアラート判定 python block
 *
 * どちらも **workflow の YAML からそのまま取り出して** 実行する
 * （db-readonly-check 系の chat-outbox-readonly-counts-pg17.mjs と同じ方針。
 *   テスト側に predicate や閾値を写すと、workflow のみが直された時に
 *   この回帰が嘘の合格をするため）。
 *
 * 集計はテーブル全体に対するグローバル集計であるため、同一 job 内の先行 fixture
 * （paced-multi-draw 等）が残した行を baseline として差し引いて検証する:
 *   - 件数系の assertion は常に「seed 後の値 - baseline の値」で判定する
 *   - age 系の assertion は下限だけを見る（seed 行は必ず集合に含まれるため、
 *     min/max の結果は seed 行の age を下回らない。baseline 行がさらに古い
 *     場合は age がさらに大きくなるだけで assertion は成立する）
 *   - no-alert シナリオの前提として「baseline 自体が滞留閾値を超えていない」
 *     ことを最初に明示的に確認する（先行 fixture の異常遅延を黙って誤報に
 *     変えないため。超えていた場合は fixture を失敗させる）
 *   - 本 fixture が投入する行は batch_id / gate id に 'watch-' 接頭辞を付け、
 *     最後に削除する。他 fixture の行は触らない。
 *
 * この fixture が固定するもの:
 *   - due pending 行の age・wake 予約の新鮮/期限切れ内訳・attempt枯渇内訳が、
 *     seeded した行の実状態と一致すること（観測点 1・2 の「外から見た形」）
 *   - processing lease 失効行の最古 age（観測点の盲点埋め）
 *   - gate / far-future 行の参考値
 *   - 上記の組で、アラート判定が次の期待どおりに決まること:
 *       healthy          → alert なし
 *       due 停滞(予約新鮮) → due_pending_stall
 *       due 停滞(予約切れ) → due_pending_stall
 *       attempt 枯渇滞留   → due_pending_stall
 *       lease 失効放置     → processing_lease_stall
 *       queue 滞留のみ     → queue_backlog_stall（DB 側は健康）
 *
 * npm 依存は使わない（migration job には npm ci が無い）。psql と node 標準モジュール
 * と python3 だけを使う。使い捨ての DB（migration 適用済み）に対して実行する。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PSQL_ARGS = [
  '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-h', process.env.PGHOST || '127.0.0.1',
  '-p', process.env.PGPORT || '5432',
  '-U', process.env.PGUSER || 'postgres',
  '-d', process.env.PGDATABASE || 'postgres',
]
const psql = (input) => execFileSync('psql', PSQL_ARGS, { input, encoding: 'utf8' })

/** YAML の block scalar から、指定 step の heredoc 本体を取り出す（依存パッケージを使わない）。 */
function extractHeredoc(workflowText, stepName, marker) {
  const lines = workflowText.split('\n')
  const stepIndex = lines.findIndex((line) => line.includes(`- name: ${stepName}`))
  assert.ok(stepIndex >= 0, `step "${stepName}" が workflow に見つかりません`)
  const heredocRel = lines.slice(stepIndex).findIndex((line) => line.includes(`<<'${marker}'`))
  assert.ok(heredocRel >= 0, `step "${stepName}" に <<'${marker}' heredoc がありません`)
  const bodyStart = stepIndex + heredocRel + 1
  let bodyEnd = bodyStart
  while (bodyEnd < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[bodyEnd])) bodyEnd += 1
  assert.ok(bodyEnd < lines.length, `heredoc の終端 ${marker} が見つかりません`)
  const body = lines.slice(bodyStart, bodyEnd)
  const indents = body.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length)
  const indent = Math.min(...indents)
  return body.map((line) => line.slice(indent)).join('\n')
}

const WORKFLOW_PATH = process.argv[2] || '.github/workflows/chat-outbox-watch.yml'
const workflowText = readFileSync(WORKFLOW_PATH, 'utf8')
const metricsSql = extractHeredoc(workflowText, 'Observe outbox stagnation metrics (read-only)', 'SQL')
const evaluatePython = extractHeredoc(workflowText, 'Evaluate alert conditions', 'PY')
assert.ok(metricsSql.includes('due_pending_rows'), '取り出した SQL に due_pending_rows がありません')
assert.ok(evaluatePython.includes('STALL_ALERT_THRESHOLD_SECONDS'), '取り出した python に閾値参照がありません')

const THRESHOLD_SECONDS = 300

/** 観測 SQL を実行して metrics JSON を返す。 */
const observeMetrics = () => JSON.parse(psql(metricsSql))

/** 判定 python block を実行して outputs（alert / reasons / message）を返す。 */
function evaluateDecision(metricsJson, queueJson) {
  const outputDir = mkdtempSync(join(tmpdir(), 'chat-outbox-watch-'))
  const outputFile = join(outputDir, 'github-output')
  const stdout = execFileSync('python3', ['-c', evaluatePython], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WATCH_METRICS_JSON: JSON.stringify(metricsJson),
      // queue 観測が無い場合は空文字（workflow の step output も同じ形）。
      WATCH_QUEUE_METRICS_JSON: queueJson == null ? '' : JSON.stringify(queueJson),
      STALL_ALERT_THRESHOLD_SECONDS: String(THRESHOLD_SECONDS),
      WATCH_RUN_URL: 'https://example.invalid/run',
      GITHUB_OUTPUT: outputFile,
    },
  })
  const raw = readFileSync(outputFile, 'utf8')
  const outputs = {}
  for (const match of raw.matchAll(/(\w+)<<WATCH_OUTPUT_EOF\n([\s\S]*?)\nWATCH_OUTPUT_EOF/g)) {
    outputs[match[1]] = match[2]
  }
  return { stdout, outputs }
}

/** 件数系 assertion: seed 後の値から baseline を差し引いて判定する。 */
function assertDelta(metrics, baseline, key, expected, label) {
  const actual = metrics[key] - baseline[key]
  assert.equal(
    actual,
    expected,
    `${label}: ${key} の増分は ${expected} を期待（baseline=${baseline[key]} 実際=${metrics[key]}）`,
  )
}

/**
 * queue 観測 step の python block を urllib スタブ付きで実行するハーネス。
 *
 * 実 API（Cloudflare Queues）の応答形を与えて、queue_json の組み立てと縮退
 * （403・通信断・queue 不在）をネットワーク無しで固定する。実 API は Queue
 * オブジェクトの名前を **queue_name** で返す（name ではない）ため、この解析は
 * 実測でしか気づけない退行になりやすい（実際に本番で queue が見つからない
 * 事故が起きた）。ここで payload 形を固定して再発を防ぐ。
 */
const QUEUE_STUB_HARNESS = String.raw`
import json
import os
import sys
import time
import types

mode = os.environ["STUB_MODE"]
now_ms = int(time.time() * 1000)

list_payloads = {
    "found": {
        "success": True,
        "result": [
            {"queue_id": "stub-queue-id-1", "queue_name": "other-queue"},
            {"queue_id": "stub-queue-id-2", "queue_name": os.environ["WATCH_QUEUE_NAME"]},
        ],
    },
    "name-fallback": {
        "success": True,
        "result": [{"queue_id": "stub-queue-id-1", "name": os.environ["WATCH_QUEUE_NAME"]}],
    },
    "missing": {
        "success": True,
        "result": [{"queue_id": "stub-queue-id-1", "queue_name": "other-queue"}],
    },
}
metrics_payload = {
    "success": True,
    "result": {
        "backlog_count": 7,
        "backlog_bytes": 1234,
        "oldest_message_timestamp_ms": now_ms - 402000,
    },
}

fake_error = types.ModuleType("urllib.error")


class URLError(Exception):
    pass


class HTTPError(URLError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


fake_error.URLError = URLError
fake_error.HTTPError = HTTPError

fake_request = types.ModuleType("urllib.request")


class Request:
    def __init__(self, url, headers=None, **kwargs):
        self.full_url = url


class Response:
    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def urlopen(request, timeout=None):
    url = request.full_url
    if "?" in url:
        if mode == "forbidden":
            raise HTTPError(403)
        if mode == "network":
            raise URLError("stub network failure")
        return Response(list_payloads[mode])
    return Response(metrics_payload)


fake_request.Request = Request
fake_request.urlopen = urlopen

import urllib

sys.modules["urllib.request"] = fake_request
sys.modules["urllib.error"] = fake_error
urllib.request = fake_request
urllib.error = fake_error

source = open(os.environ["QUEUE_BLOCK_PATH"], encoding="utf-8").read()
try:
    exec(compile(source, "queue-block", "exec"), {"__name__": "__main__"})
except SystemExit as exc:
    sys.exit(0 if exc.code in (0, None) else 1)
`

/** queue 観測 python block を STUB_MODE で実行し、outputs と標準出力を返す。 */
function runQueueBlockWithStub(queuePython, mode) {
  const workDir = mkdtempSync(join(tmpdir(), 'chat-outbox-watch-queue-'))
  const blockPath = join(workDir, 'queue_block.py')
  const harnessPath = join(workDir, 'harness.py')
  const outputFile = join(workDir, 'github-output')
  writeFileSync(blockPath, queuePython)
  writeFileSync(harnessPath, QUEUE_STUB_HARNESS)
  const result = spawnSync('python3', [harnessPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      STUB_MODE: mode,
      QUEUE_BLOCK_PATH: blockPath,
      GITHUB_OUTPUT: outputFile,
      CLOUDFLARE_ACCOUNT_ID: 'stub-account',
      CLOUDFLARE_API_TOKEN: 'stub-token',
      WATCH_QUEUE_NAME: 'chat-notification-wakeup',
    },
  })
  const outputs = {}
  try {
    const raw = readFileSync(outputFile, 'utf8')
    for (const match of raw.matchAll(/(\w+)<<WATCH_OUTPUT_EOF\n([\s\S]*?)\nWATCH_OUTPUT_EOF/g)) {
      outputs[match[1]] = match[2]
    }
  } catch {
    // 縮退時は GITHUB_OUTPUT が作られない（出力なしが期待値）。
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', outputs }
}

const PREFIX = 'watch-'
const cleanup = () => psql(`
DELETE FROM public.chat_notification_outbox WHERE batch_id LIKE '${PREFIX}%';
DELETE FROM public.chat_channel_send_gate WHERE broadcaster_twitch_user_id LIKE '${PREFIX}%';
`)

/** 1行の outbox 行を投入する。created_at は next_attempt_at とは別の値にできる。 */
function insertOutbox({
  batchId,
  status = 'pending',
  dueSecondsAgo = null,
  createdSecondsAgo = null,
  wakeReservedSecondsFromNow = null,
  leaseSecondsFromNow = null,
  attemptCount = 0,
}) {
  // status='sent' は sent_at が必須（check2 制約）。'pending'/'processing' は
  // sent_at/dead_at とも NULL が必須。
  const sentAtExpr = status === 'sent' ? 'now()' : 'NULL'
  psql(`
INSERT INTO public.chat_notification_outbox
  (batch_id, payload, expected_draw_count, assembled_draw_count, status, next_attempt_at,
   created_at, wake_reserved_until, lease_id, lease_expires_at, attempt_count, sent_at)
VALUES (
  '${PREFIX}${batchId}', '{}'::jsonb, 12, 12, '${status}',
  ${dueSecondsAgo === null ? 'now()' : `now() - interval '${dueSecondsAgo} seconds'`},
  ${createdSecondsAgo === null ? 'now()' : `now() - interval '${createdSecondsAgo} seconds'`},
  ${wakeReservedSecondsFromNow === null ? 'NULL' : `now() + interval '${wakeReservedSecondsFromNow} seconds'`},
  ${leaseSecondsFromNow === null ? 'NULL' : `gen_random_uuid()`},
  ${leaseSecondsFromNow === null ? 'NULL' : `now() + interval '${leaseSecondsFromNow} seconds'`},
  ${attemptCount},
  ${sentAtExpr}
);
`)
}

let scenarios = 0
try {
  cleanup()
  const baseline = observeMetrics()

  // no-alert シナリオの前提: baseline（先行 fixture の残行を含む）が滞留閾値を
  // 超えている場合、healthy シナリオの「alert なし」検証は無意味になる。
  // 黙って誤った合格にさせず、ここで明示的に失敗させる。
  assert.ok(
    baseline.oldest_due_next_attempt_age_seconds <= THRESHOLD_SECONDS,
    `baseline の最古 due 行が閾値（${THRESHOLD_SECONDS} 秒）を超えている（${baseline.oldest_due_next_attempt_age_seconds} 秒）。` +
      '先行 fixture の実行が遅延しているか、本 fixture が使い捨てでない DB で実行されている。',
  )
  assert.ok(
    baseline.oldest_processing_lease_expired_age_seconds <= THRESHOLD_SECONDS,
    `baseline の最古 lease 失効行が閾値（${THRESHOLD_SECONDS} 秒）を超えている（${baseline.oldest_processing_lease_expired_age_seconds} 秒）。` +
      '先行 fixture の実行が遅延しているか、本 fixture が使い捨てでない DB で実行されている。',
  )

  // ---- A: 健康。due になったばかり（sweep 予約は新鮮）＋有効 lease の processing ＋ sent ----
  {
    insertOutbox({ batchId: 'a-due-fresh', dueSecondsAgo: 30, createdSecondsAgo: 45, wakeReservedSecondsFromNow: 90 })
    insertOutbox({ batchId: 'a-processing', status: 'processing', dueSecondsAgo: 120, leaseSecondsFromNow: 60 })
    insertOutbox({ batchId: 'a-sent', status: 'sent' })
    const metrics = observeMetrics()
    assertDelta(metrics, baseline, 'due_pending_rows', 1, 'A')
    assertDelta(metrics, baseline, 'due_pending_reserved_rows', 1, 'A')
    assertDelta(metrics, baseline, 'due_pending_reservation_expired_rows', 0, 'A')
    assertDelta(metrics, baseline, 'due_pending_attempt_exhausted_rows', 0, 'A')
    // age は下限だけ見る（min は集合内の最古行を選ぶため、seed 行の 30 秒を
    // 下回らない。baseline 行がさらに古い場合はそれより大きくなる）。
    assert.ok(
      metrics.oldest_due_next_attempt_age_seconds >= 25,
      `A: due age は seed 行の 30 秒以上（実際 ${metrics.oldest_due_next_attempt_age_seconds}）`,
    )
    assertDelta(metrics, baseline, 'processing_lease_expired_rows', 0, 'A')
    const decision = evaluateDecision(metrics, null)
    assert.equal(decision.outputs.alert, 'false', 'A: アラートなし')
    assert.equal(decision.outputs.reasons, '[]', 'A: 検知理由なし')
    cleanup()
    scenarios += 1
  }

  // ---- B: due 停滞（sweep は予約だけ続けている = reserved>0 で enqueued=0 が続く形） ----
  {
    insertOutbox({ batchId: 'b-stall-fresh', dueSecondsAgo: 400, createdSecondsAgo: 600, wakeReservedSecondsFromNow: 90 })
    const metrics = observeMetrics()
    assertDelta(metrics, baseline, 'due_pending_rows', 1, 'B')
    assertDelta(metrics, baseline, 'due_pending_reserved_rows', 1, 'B')
    assert.ok(metrics.oldest_due_next_attempt_age_seconds > 390, `B: due age は閾値超過（実際 ${metrics.oldest_due_next_attempt_age_seconds}）`)
    const decision = evaluateDecision(metrics, null)
    assert.equal(decision.outputs.alert, 'true', 'B: due_pending_stall でアラート')
    assert.ok(decision.outputs.reasons.includes('due_pending_stall'), 'B: 理由に due_pending_stall')
    assert.ok(
      decision.outputs.alert_message.includes('wake予約 新鮮 1'),
      'B: アラート本文に内訳（予約新鮮 1）が含まれる',
    )
    assert.ok(
      !decision.outputs.alert_message.includes('WATCH-'),
      'B: アラート本文に行データ（batch_id 等）が含まれていない',
    )
    cleanup()
    scenarios += 1
  }

  // ---- C: due 停滞（sweep 自体が止まって予約が期限切れ = chat-delivery Worker の ----
  // ---- scheduled handler と relay sweep の両方が死んでいる形） ----
  {
    insertOutbox({ batchId: 'c-stall-expired', dueSecondsAgo: 400, createdSecondsAgo: 600 })
    const metrics = observeMetrics()
    assertDelta(metrics, baseline, 'due_pending_reservation_expired_rows', 1, 'C')
    assertDelta(metrics, baseline, 'due_pending_reserved_rows', 0, 'C')
    const decision = evaluateDecision(metrics, null)
    assert.equal(decision.outputs.alert, 'true', 'C: due_pending_stall でアラート')
    assert.ok(decision.outputs.reasons.includes('due_pending_stall'), 'C: 理由に due_pending_stall')
    cleanup()
    scenarios += 1
  }

  // ---- D: attempt 枯渇で pending のまま拾われない行（flag ON では sweep 対象外） ----
  {
    insertOutbox({ batchId: 'd-exhausted', dueSecondsAgo: 400, createdSecondsAgo: 900, attemptCount: 5 })
    const metrics = observeMetrics()
    assertDelta(metrics, baseline, 'due_pending_attempt_exhausted_rows', 1, 'D')
    const decision = evaluateDecision(metrics, null)
    assert.equal(decision.outputs.alert, 'true', 'D: due 滞留としてアラート')
    assert.ok(decision.outputs.reasons.includes('due_pending_stall'), 'D: 理由に due_pending_stall')
    assert.ok(
      decision.outputs.alert_message.includes('attempt枯渇 1'),
      'D: アラート本文に attempt枯渇内訳が含まれる',
    )
    cleanup()
    scenarios += 1
  }

  // ---- E: claim 後の行が lease 失効のまま放置（pending の滞留には現れない盲点） ----
  {
    insertOutbox({ batchId: 'e-lease-expired', status: 'processing', dueSecondsAgo: 400, leaseSecondsFromNow: -400 })
    const metrics = observeMetrics()
    assertDelta(metrics, baseline, 'due_pending_rows', 0, 'E')
    assertDelta(metrics, baseline, 'processing_lease_expired_rows', 1, 'E')
    assert.ok(
      metrics.oldest_processing_lease_expired_age_seconds > 390,
      `E: lease 失効 age は閾値超過（実際 ${metrics.oldest_processing_lease_expired_age_seconds}）`,
    )
    const decision = evaluateDecision(metrics, null)
    assert.equal(decision.outputs.alert, 'true', 'E: processing_lease_stall でアラート')
    assert.ok(decision.outputs.reasons.includes('processing_lease_stall'), 'E: 理由に processing_lease_stall')
    assert.ok(
      !decision.outputs.reasons.includes('due_pending_stall'),
      'E: due 滞留は無いため due_pending_stall は理由に含まれない',
    )
    cleanup()
    scenarios += 1
  }

  // ---- F: gate / far-future は参考値として観測されるが、単体ではアラートしない ----
  {
    insertOutbox({ batchId: 'f-far-future', dueSecondsAgo: null, createdSecondsAgo: 30 })
    psql(`
UPDATE public.chat_notification_outbox
SET next_attempt_at = now() + interval '3600 seconds'
WHERE batch_id = '${PREFIX}f-far-future';
INSERT INTO public.chat_channel_send_gate (broadcaster_twitch_user_id, next_send_at)
VALUES ('${PREFIX}far', now() + interval '3600 seconds'),
       ('${PREFIX}idle', now() - interval '600 seconds');
`)
    const metrics = observeMetrics()
    assertDelta(metrics, baseline, 'due_pending_rows', 0, 'F')
    assertDelta(metrics, baseline, 'pending_far_future_rows', 1, 'F')
    // max horizon も下限だけ見る（baseline にさらに先の行があれば大きくなる）。
    assert.ok(
      metrics.pending_max_horizon_seconds >= 3540,
      `F: pending 最大先送りは seed 行の 3600 秒以上（実際 ${metrics.pending_max_horizon_seconds}）`,
    )
    assertDelta(metrics, baseline, 'gate_far_future_rows', 1, 'F')
    assert.ok(
      metrics.gate_max_horizon_seconds >= 3540,
      `F: gate 最大先送りは seed 行の 3600 秒以上（実際 ${metrics.gate_max_horizon_seconds}）`,
    )
    const decision = evaluateDecision(metrics, null)
    assert.equal(decision.outputs.alert, 'false', 'F: far-future だけではアラートしない')
    cleanup()
    scenarios += 1
  }

  // ---- G: DB 側は健康でも queue 滞留だけなら queue_backlog_stall でアラート ----
  // ---- （token 不備などで queue 観測が無い場合は判定しない = alert なし） ----
  {
    const healthy = observeMetrics()
    const backlogDecision = evaluateDecision(healthy, {
      backlog_count: 7,
      backlog_bytes: 1234,
      oldest_backlog_age_seconds: 402,
    })
    assert.equal(backlogDecision.outputs.alert, 'true', 'G: queue_backlog_stall でアラート')
    assert.ok(backlogDecision.outputs.reasons.includes('queue_backlog_stall'), 'G: 理由に queue_backlog_stall')
    assert.ok(
      backlogDecision.outputs.alert_message.includes('queue backlog: 7 件 (最古 402 秒)'),
      'G: アラート本文に queue 滞留が含まれる',
    )

    const noQueueDecision = evaluateDecision(healthy, null)
    assert.equal(noQueueDecision.outputs.alert, 'false', 'G: queue 観測なしではアラートしない')
    assert.ok(
      noQueueDecision.outputs.heartbeat_message.includes('queue 観測なし'),
      'G: 生存確認本文に queue 観測なしと明記される',
    )

    const emptyQueueDecision = evaluateDecision(healthy, {
      backlog_count: 0,
      backlog_bytes: 0,
      oldest_backlog_age_seconds: 0,
    })
    assert.equal(emptyQueueDecision.outputs.alert, 'false', 'G: backlog 0 ではアラートしない')
    scenarios += 1
  }

  // ---- H: queue 観測 step の API 応答解析（urllib スタブ実行） ----
  // ---- 実 API は Queue オブジェクトの名前を queue_name で返す。 ----
  {
    const queuePython = extractHeredoc(
      workflowText,
      'Observe the wakeup queue backlog (best effort)',
      'PY',
    )

    // H1: 実 API 形（queue_name）で queue を見つけ、metrics から queue_json を組む。
    const found = runQueueBlockWithStub(queuePython, 'found')
    assert.equal(found.status, 0, `H1: 正常終了（stderr: ${found.stderr}）`)
    assert.ok(found.outputs.queue_json, 'H1: queue_json が出力される')
    const foundMetrics = JSON.parse(found.outputs.queue_json)
    assert.equal(foundMetrics.backlog_count, 7, 'H1: backlog_count')
    assert.equal(foundMetrics.backlog_bytes, 1234, 'H1: backlog_bytes')
    assert.ok(
      foundMetrics.oldest_backlog_age_seconds >= 390 && foundMetrics.oldest_backlog_age_seconds <= 412,
      `H1: 最古滞留 age は約 402 秒（実際 ${foundMetrics.oldest_backlog_age_seconds}）`,
    )
    assert.ok(found.stdout.includes('backlog_count=7'), 'H1: 公開ログに件数が出力される')
    assert.ok(!found.stdout.includes('stub-queue-id'), 'H1: 公開ログに queue ID を出さない')

    // H2: 旧来の name フィールドでも見つけられる（別名の許容）。
    const fallback = runQueueBlockWithStub(queuePython, 'name-fallback')
    assert.equal(fallback.status, 0, `H2: 正常終了（stderr: ${fallback.stderr}）`)
    assert.ok(fallback.outputs.queue_json, 'H2: name フィールドでも queue_json が出力される')

    // H3: queue 不在は警告のみで縮退する（出力なし・終了コード 0）。
    const missing = runQueueBlockWithStub(queuePython, 'missing')
    assert.equal(missing.status, 0, 'H3: 終了コード 0（watch を止めない）')
    assert.ok(!missing.outputs.queue_json, 'H3: queue_json は出力されない')
    assert.ok(
      missing.stdout.includes('was not found') && missing.stdout.includes('::warning::'),
      'H3: 警告に queue 不在が明示される',
    )

    // H4: token 権限不足（403）も警告のみで縮退する。
    const forbidden = runQueueBlockWithStub(queuePython, 'forbidden')
    assert.equal(forbidden.status, 0, 'H4: 終了コード 0（watch を止めない）')
    assert.ok(!forbidden.outputs.queue_json, 'H4: queue_json は出力されない')
    assert.ok(forbidden.stdout.includes('HTTP 403'), 'H4: 警告に HTTP 403 が明示される')

    // H5: 通信断も警告のみで縮退する。
    const network = runQueueBlockWithStub(queuePython, 'network')
    assert.equal(network.status, 0, 'H5: 終了コード 0（watch を止めない）')
    assert.ok(!network.outputs.queue_json, 'H5: queue_json は出力されない')
    assert.ok(network.stdout.includes('queue metrics request failed'), 'H5: 警告に通信失敗が明示される')

    scenarios += 1
  }

  cleanup()
  console.log(`OK  chat-outbox-watch (${WORKFLOW_PATH}): ${scenarios} scenarios passed`)
} finally {
  cleanup()
}
