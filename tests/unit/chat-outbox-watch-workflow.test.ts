import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string) {
  return readFileSync(path, 'utf8')
}

/**
 * `.github/workflows/chat-outbox-watch.yml` は **production** の DB secret と
 * Cloudflare token を 5 分周期で使う workflow なので、Issue #1837 の観測点として
 * 次の性質を機械的に固定する:
 *
 * - production 以外の Environment / ref から secret へ到達しない
 * - SQL に書き込み文が無い（DB は観測対象であって操作対象ではない）
 * - 出力・通知に個別行データ（batch_id / last_error / payload）を含まない
 * - アラート条件（due 滞留 / lease 失効放置 / queue 滞留）が閾値定数を経由して
 *   判定 block に存在する
 * - アラート時は通知の成否・抑制の有無にかかわらず run が failure になる
 *   （赤 run という第 2 の可視経路を毎周期維持するため）
 *
 * 実DBを伴う検証（集計 SQL と判定 python block の意味論）は
 * tests/fixtures/chat-outbox-watch-pg17.mjs が PG17 job で行う。
 */
describe('chat-outbox-watch workflow contract (Issue #1837)', () => {
  const workflow = read('.github/workflows/chat-outbox-watch.yml')

  /** heredoc (`<<'MARKER'` … `MARKER`) の中身を取り出し、共通インデントを除去して返す。 */
  function heredocBlocks(text: string, marker: string): string[] {
    const pattern = new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n\\s*${marker}`, 'g')
    return [...text.matchAll(pattern)].map((match) => {
      const lines = match[1].split('\n')
      const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0)
      const indent = Math.min(...indents)
      return lines.map((line) => line.slice(indent)).join('\n')
    })
  }
  const sqlBlocks = heredocBlocks(workflow, 'SQL')
  const pyBlocks = heredocBlocks(workflow, 'PY')
  const evaluateBlock = pyBlocks.find((block) => block.includes('reasons.append'))
  if (evaluateBlock === undefined) {
    // 以降のテストがすべて判定 block の内容を検査するため、収集時に失敗させる。
    throw new Error('Evaluate alert conditions step の python block が取り出せません')
  }

  it('5 分周期の schedule と workflow_dispatch（heartbeat 入力のみ）で起動する', () => {
    expect(workflow).toContain('schedule:')
    expect(workflow).toContain('- cron: "*/5 * * * *"')
    expect(workflow).toContain('workflow_dispatch:')
    // input は heartbeat（通知文面の選択）だけ。SQL・閾値・Environment を差し替える
    // input は持たせない。
    const dispatchInputs = workflow.slice(
      workflow.indexOf('workflow_dispatch:'),
      workflow.indexOf('concurrency:'),
    )
    const inputKeys = [...dispatchInputs.matchAll(/^ {6}([a-z_]+):$/gm)].map((match) => match[1])
    expect(inputKeys).toEqual(['heartbeat'])
    expect(dispatchInputs).toContain('type: boolean')
    expect(dispatchInputs).toContain('default: false')
  })

  it('environment を production に固定する（input や条件式で切り替えられない）', () => {
    expect(workflow).toContain('environment: production')
    expect(workflow).not.toContain("github.ref == 'refs/heads/preview' && 'preview' || 'production'")
  })

  it('main 以外の ref を二重で拒否する（feature branch へ production の secret を渡さない）', () => {
    // workflow_dispatch は任意 ref を選べるため、job-level の条件だけでは足りない。
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'")
    expect(workflow).toContain('if [ "$GITHUB_REF" != "refs/heads/main" ]; then')
    expect(workflow).not.toContain("|| github.ref == 'refs/heads/preview'")
  })

  it('セッション全体を読み取り専用にし、観測の前に実効値を確認する', () => {
    expect(workflow).toContain('PGOPTIONS: "-c default_transaction_read_only=on')
    expect(workflow).toContain('SHOW transaction_read_only')
    expect(workflow).toContain('expected transaction_read_only=on')
    const verifyIndex = workflow.indexOf('Verify the session is read-only before observing')
    const observeIndex = workflow.indexOf('Observe outbox stagnation metrics (read-only)')
    expect(verifyIndex).toBeGreaterThan(-1)
    expect(observeIndex).toBeGreaterThan(verifyIndex)
  })

  it('repo を checkout しない / permissions は最小 / timeout がある / 連続実行をキャンセルしない', () => {
    expect(workflow).not.toContain('actions/checkout')
    expect(workflow).toContain('permissions:')
    expect(workflow).toContain('contents: read')
    // 抑制 anchor（最終送信時刻）の記録に commit status を使うため statuses: write
    // が必要。workflow run 一覧は読まないため actions: read は不要になった。
    expect(workflow).toContain('statuses: write')
    expect(workflow).not.toContain('actions: read')
    expect(workflow).toContain('timeout-minutes: 5')
    // 観測中の run をキャンセルすると送信中のアラートが失われるため、並走は
    // キューに並べる（db-readonly-check-production.yml と同じ）。
    expect(workflow).toContain('group: chat-outbox-watch')
    expect(workflow).toContain('cancel-in-progress: false')
  })

  it('psql に渡す SQL に書き込み系の文を持たない', () => {
    expect(sqlBlocks.length).toBe(1)
    for (const block of sqlBlocks) {
      expect(block).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i,
      )
    }
  })

  it('SQL が due 滞留・lease 失効・wake 予約の内訳と gate 参考値を観測する', () => {
    const sql = sqlBlocks[0]
    expect(sql).toContain("'observed_at', now()")
    expect(sql).toContain('due_pending_rows')
    expect(sql).toContain('due_pending_reserved_rows')
    expect(sql).toContain('due_pending_reservation_expired_rows')
    expect(sql).toContain('due_pending_attempt_exhausted_rows')
    expect(sql).toContain('oldest_due_next_attempt_age_seconds')
    expect(sql).toContain('oldest_due_created_age_seconds')
    expect(sql).toContain('processing_lease_expired_rows')
    expect(sql).toContain('oldest_processing_lease_expired_age_seconds')
    expect(sql).toContain('pending_far_future_rows')
    expect(sql).toContain('gate_far_future_rows')
    // CHAT_OUTBOX_MAX_ATTEMPTS（src/lib/services/chat-notification-outbox.ts）と
    // 同じ値。変更時はここも揃える。
    expect(sql).toContain('attempt_count >= 5')
    expect(workflow).toContain('CHAT_OUTBOX_MAX_ATTEMPTS')
  })

  it('SQL に個別行データを出力しない（batch_id / last_error / payload / DB 名を出さない）', () => {
    const sql = sqlBlocks[0]
    // SELECT対象は集計列だけ。行データ（batch_id・last_error・payload）と DB 名は
    // 公開ログ・通知に載せない。
    expect(sql).not.toContain('last_error')
    expect(sql).not.toContain('batch_id')
    expect(sql).not.toContain('payload')
    expect(sql).not.toContain('current_database()')
  })

  it('閾値は workflow env に一度だけ定義され、判定 block は env を参照する', () => {
    expect(workflow).toContain('STALL_ALERT_THRESHOLD_SECONDS: "300"')
    expect(evaluateBlock).toBeDefined()
    expect(evaluateBlock).toContain('int(os.environ["STALL_ALERT_THRESHOLD_SECONDS"])')
    // 閾値の直書き（マジックナンバー化）は判定 block 内に許さない。
    expect(evaluateBlock).not.toMatch(/>\s*300\b/)
  })

  it('判定 block が3つのアラート条件を持つ（due 滞留 / lease 失効放置 / queue 滞留）', () => {
    expect(evaluateBlock).toContain('due_pending_stall')
    expect(evaluateBlock).toContain('processing_lease_stall')
    expect(evaluateBlock).toContain('queue_backlog_stall')
    // queue 観測が無い（token 不備・queue 未作成）場合は queue 条件を判定しない。
    expect(evaluateBlock).toContain('queue is not None')
    // 通知本文は metrics の数値のみから組み立てる（行データを埋め込まない）。
    // コメント行は検査対象から除外する（「埋め込まない」旨の説明自体は許す）。
    const evaluateCode = evaluateBlock
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(evaluateCode).not.toContain('batch_id')
    expect(evaluateCode).not.toContain('last_error')
    expect(evaluateCode).not.toContain('payload')
  })

  it('heartbeat は workflow_dispatch の input のときだけ送り、SQL・閾値には影響しない', () => {
    expect(workflow).toContain(
      "HEARTBEAT: ${{ github.event_name == 'workflow_dispatch' && inputs.heartbeat == true && 'true' || 'false' }}",
    )
    // schedule 実行（既定）では heartbeat 分岐に入らない。
    expect(workflow).toContain('if [ "$HEARTBEAT" = "true" ]; then')
  })

  it('アラート時は抑制・送信の成否にかかわらず run を failure にする', () => {
    const notifyIndex = workflow.indexOf('Notify Discord and conclude the run')
    expect(notifyIndex).toBeGreaterThan(-1)
    const notifyStep = workflow.slice(notifyIndex)
    // 抑制 path: 送信を省いても failure として記録する。
    const suppressExit = notifyStep.indexOf('::warning::最終送信から抑制窓内のため')
    const suppressExit1 = notifyStep.indexOf('exit 1', suppressExit)
    expect(suppressExit).toBeGreaterThan(-1)
    expect(suppressExit1).toBeGreaterThan(suppressExit)
    // 送信 path: 送信後も failure にする。
    const sendIndex = notifyStep.indexOf('sending the stall alert to Discord')
    const sendExit1 = notifyStep.indexOf('exit 1', sendIndex)
    expect(sendIndex).toBeGreaterThan(-1)
    expect(sendExit1).toBeGreaterThan(sendIndex)
  })

  it('抑制判定の anchor は「実際に送信した run」だけが作る commit status である', () => {
    const notifyIndex = workflow.indexOf('Notify Discord and conclude the run')
    const notifyStep = workflow.slice(notifyIndex)
    // anchor の参照: main HEAD の combined status から context で絞り込む。
    expect(notifyStep).toContain('/commits/')
    expect(notifyStep).toContain('/status')
    expect(notifyStep).toContain('chat-outbox-watch/alert')
    // anchor の記録: 送信後に state=failure の status を作る（target_url は run）。
    expect(notifyStep).toContain('/statuses/')
    expect(notifyStep).toContain('"state": "failure"')
    expect(notifyStep).toContain('target_url')
    // workflow run 一覧を anchor にしない（直前 run の時刻は 5 分周期では常に
    // 抑制窓内になり、窓が永久に満了しない退行を防ぐ）。
    expect(notifyStep).not.toContain('workflow_runs')
    expect(notifyStep).toContain('ALERT_SUPPRESS_WINDOW_SECONDS')
    // 判定の API 失敗時は送信続行（fail-open。抑制は頻度制御であって安全機構ではない）。
    expect(notifyStep).toContain('抑制判定に失敗したため、送信を続行する')
    // anchor 記録の失敗は送信済みのアラートを無効化しない（warning のみ）。
    expect(notifyStep).toContain('failed to record the alert anchor status')
    // GH_TOKEN は github.token（GITHUB_TOKEN）だけで、個人 token を要求しない。
    expect(notifyStep).toContain('GH_TOKEN: ${{ github.token }}')
  })

  it('Discord 通知は repo secret の webhook だけを使い、本文は step output 経由で渡す', () => {
    expect(workflow).toContain('DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}')
    // 本文は env 経由（${{ }} の直接展開はしない）。
    expect(workflow).toContain('ALERT_MESSAGE: ${{ steps.evaluate.outputs.alert_message }}')
    expect(workflow).toContain('HEARTBEAT_MESSAGE: ${{ steps.evaluate.outputs.heartbeat_message }}')
    expect(workflow).toContain('os.environ["ALERT_MESSAGE"]')
    expect(workflow).toContain('os.environ["HEARTBEAT_MESSAGE"]')
    // webhook 未設定では送信を試みず失敗する（fail-closed）。
    expect(workflow).toContain('DISCORD_WEBHOOK_URL is not configured')
  })

  it('queue 観測は権限・通信エラーで watch を止めない（警告と空出力で縮退する）', () => {
    const queueIndex = workflow.indexOf('Observe the wakeup queue backlog (best effort)')
    const queueStep = workflow.slice(queueIndex, workflow.indexOf('Evaluate alert conditions'))
    // realtime backlog metrics API（backlog_count / oldest_message_timestamp_ms）。
    expect(queueStep).toContain('/queues')
    expect(queueStep).toContain('/metrics')
    // HTTP エラー（403 = token の Queue 読み取り権限不足を含む）・通信断は
    // warning と exit 0 で縮退し、DB 側の検知を継続する。
    expect(queueStep).toContain('except urllib.error.HTTPError as error')
    expect(queueStep).toContain('sys.exit(0)')
    // 公開ログに queue ID を出力しない（名前と件数だけ）。
    expect(queueStep).not.toContain('queue_id=')
    expect(queueStep).toContain("backlog_count={payload['backlog_count']}")
    // queue_json は空でも（出力が無くても）判定 step が動く。
    expect(workflow).toContain('WATCH_QUEUE_METRICS_JSON: ${{ steps.queue.outputs.queue_json }}')
  })

  it('同一 step 名・heredoc 構造が fixture の抽出対象と一致する', () => {
    // tests/fixtures/chat-outbox-watch-pg17.mjs は step 名と heredoc marker で
    // SQL と判定 python を取り出す。step 名を変える場合は fixture も揃えること。
    expect(workflow).toContain('- name: Observe outbox stagnation metrics (read-only)')
    expect(workflow).toContain('- name: Evaluate alert conditions')
    const fixture = read('tests/fixtures/chat-outbox-watch-pg17.mjs')
    expect(fixture).toContain('Observe outbox stagnation metrics (read-only)')
    expect(fixture).toContain('Evaluate alert conditions')
    expect(fixture).toContain("<<'${marker}'")
  })
})
