// preview の実チャネルポイント交換テスト（ローカル専用。docs/QA.md「Preview 実経路ゲート」）。
//
//   npm run e2e:preview-redemption -- login            専用プロファイルの Chrome を通常起動し、Twitch と preview に手動ログインする（初回のみ）
//   npm run e2e:preview-redemption -- check            交換せずに overlay / 報酬メニュー / 履歴API / チャット / Worker tail の到達性を確認する
//   npm run e2e:preview-redemption -- run [--count N]  実交換を N 回（既定 2）行い、overlay・Twitch チャット・ガチャ履歴・Worker ログを交換ごとに突き合わせる
//
// 固定 preview URL 以外には接続しない。Cookie・トークンを読み出したり出力したりしない。
// 結果は ~/.twica-preview-e2e/runs/<時刻>-<mode>/ に result.json・worker-logs.json・スクリーンショットで残す。
// Worker ログには `wrangler login` 済みであることが必要（`--logs off` で省略できる）。

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { constants as osConstants, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = 'https://twica-preview.tsubasa-azumagakito.workers.dev'
const DEFAULTS = {
  channel: 'azumagbanjo',
  reward: 'ドッスン君？！',
  // 履歴・overlay・チャット通知に出る交換者名（user_twitch_username）は Twitch の表示名で、
  // ログイン名ではない（2026-11-02 の実交換で `あずまぐ` と記録された）。
  user: 'あずまぐ',
  streamerId: '9d0f9d09-3972-4aa2-b32e-c6d222a6cfd9',
  count: 2,
  logs: 'on',
}
const HOME = join(homedir(), '.twica-preview-e2e')
const PROFILE = join(HOME, 'chrome-profile')
const OVERLAY_TIMEOUT_MS = 20_000
const CHAT_TIMEOUT_MS = 45_000
const HISTORY_TIMEOUT_MS = 30_000
// DB の redeemed_at（サーバ時計）とローカルのクリック時刻の比較に使う許容ずれ。
// knownIds が古い行を除外済みなので、ローカル時計が数秒進んでいても新しい行を落とさない
// よう緩める（2026-11-02 実測のずれは約 4ms、余裕は 1.6〜1.8 秒）。
const HISTORY_SKEW_MS = 3_000
// QA.md「固定overlayの先行観測順序」の目安は受信後 2〜5 秒。latencyMs は記録だけでなく
// この上限を超えたらその交換を不合格にする。
const OVERLAY_LATENCY_TARGET_MS = 5_000
// 「2xx を返した後の canceled」を失敗から外してよい根拠は overlay-realtime の publish
// 経路（src/lib/overlay-realtime/publisher.ts の discardResponseBody）だけなので、
// そのパスに限定する。他のパスの canceled は引き続き失敗として数える。
const PUBLISH_PATH = /^\/internal\/v1\/rooms\/[^/]+\/publish$/

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = { ...DEFAULTS }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '')
    const value = rest[i + 1]
    if (!Object.hasOwn(DEFAULTS, key) || value === undefined) throw new Error(`unknown or incomplete option: ${rest[i]}`)
    opts[key] = key === 'count' ? Number(value) : value
  }
  if (!/^[a-z0-9_]{3,25}$/.test(opts.channel)) throw new Error(`invalid channel login: ${opts.channel}`)
  // 表示名は大文字小文字だけがログイン名と違うことがあるため、小文字にそろえて比較する。
  opts.user = opts.user.toLowerCase()
  if (!/^[^\s@]{1,25}$/u.test(opts.user)) throw new Error(`invalid user display name: ${opts.user}`)
  if (!/^[0-9a-f-]{36}$/.test(opts.streamerId)) throw new Error(`invalid streamerId: ${opts.streamerId}`)
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 5) throw new Error('count must be 1..5')
  if (!['on', 'off'].includes(opts.logs)) throw new Error('logs must be on|off')
  return { command, opts }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => new Date().toISOString()

async function launch() {
  mkdirSync(PROFILE, { recursive: true })
  // unit test から純粋関数だけを読み込めるよう、ブラウザ依存は実行時に読み込む。
  const { chromium } = await import('playwright-core')
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    // login で通常起動した Chrome は Cookie を macOS キーチェーンの鍵で暗号化して保存する。
    // Playwright 既定の --use-mock-keychain のままだと復号できず、未ログインに見える。
    ignoreDefaultArgs: ['--use-mock-keychain'],
    // overlay と chat は背景タブでも観測し続けるため、タイマー間引きを止める。
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  })
  activeContext = context
  return context
}

// ---- overlay ---------------------------------------------------------------

async function openOverlay(context, streamerId) {
  const page = await context.newPage()
  await page.goto(`${APP}/overlay/${streamerId}?debug=true`, { waitUntil: 'domcontentloaded' })
  await page.getByText(/Status: connected/).waitFor({ timeout: 30_000 })
  return page
}

// 最初に陽性になった sample（カード DOM + 画像画素）を返す。
// 返り値は { samples, epoch } で、epoch はリロード検出に使う世代マーカー。
async function observeOverlayCards(page, sinceMs, previousInstances, out, n) {
  const samples = new Map()
  let latestEpoch = null
  const deadline = Date.now() + OVERLAY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => {
      // overlay が交換中にリロードされると表示インスタンス番号が 1 から振り直され、
      // 今回の表示が前回と同じ番号で「既出」と誤判定される（偽陰性）。リロードで
      // グローバル変数が消えることを利用し、世代マーカーでリロードを検出する。
      window.__twicaOverlayEpoch ??= Math.random().toString(36).slice(2)
      const root = document.querySelector('[data-overlay-card="true"]')
      if (!root) return { epoch: window.__twicaOverlayEpoch, empty: true }
      const style = getComputedStyle(root)
      const rect = root.getBoundingClientRect()
      const img = root.querySelector('img')
      const fallback = root.querySelector('[data-overlay-card-fallback="true"]')
      return {
        epoch: window.__twicaOverlayEpoch,
        instance: root.getAttribute('data-overlay-display-instance'),
        text: root.innerText.trim().slice(0, 200),
        // Exact visible identities: names hidden by image-only settings cannot prove correlation.
        card: root.querySelector('h2')?.textContent?.trim() || img?.alt ||
          fallback?.getAttribute('aria-label')?.replace(/ の画像を表示できないため代替表示$/, '') || null,
        user: root.innerText.match(/(?:^|\n)([^\n]+) が引いたカード(?:\n|$)/)?.[1]?.trim() ?? null,
        opacity: style.opacity,
        visibility: style.visibility,
        rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
        image: img ? { complete: img.complete, w: img.naturalWidth, h: img.naturalHeight } : null,
        fallback: Boolean(fallback),
      }
    })
    // リロード検出用の世代マーカーを呼び出し側へ伝える。
    if (sample?.epoch && sample.epoch !== latestEpoch) latestEpoch = sample.epoch
    const visible = sample && !sample.empty && sample.visibility !== 'hidden' &&
      Number(sample.opacity) > 0 && sample.rect?.w > 0
    const painted = sample && !sample.empty &&
      (sample.fallback || (sample.image?.complete && sample.image.w > 0 && sample.image.h > 0))
    // instance 番号はリロードで振り直されるため、世代（epoch）込みで重複を除く。
    const key = sample?.epoch && sample?.instance ? `${sample.epoch}:${sample.instance}` : null
    if (visible && painted && sample.instance && key && !previousInstances.has(key) && !samples.has(key)) {
      const observedAt = Date.now()
      const latencyMs = observedAt - sinceMs
      const screenshot = `${n}-overlay-${samples.size + 1}.png`
      await page.screenshot({ path: join(out, screenshot) })
      samples.set(key, { ...sample, observedAt, latencyMs, latencyOk: latencyMs <= OVERLAY_LATENCY_TARGET_MS, screenshot })
    }
    await sleep(300)
  }
  return { samples: [...samples.values()], epoch: latestEpoch }
}

// 世代マーカー。リロードでグローバルが消えるため、値が変わればリロードと分かる。
async function overlayEpoch(page) {
  return page.evaluate(() => (window.__twicaOverlayEpoch ??= Math.random().toString(36).slice(2)))
}

// ---- history (preview app session) ----------------------------------------

async function openApp(context) {
  const page = await context.newPage()
  // dashboard はクライアント側で遷移することがあるため、落ち着いてから same-origin fetch に使う。
  await page.goto(`${APP}/dashboard`, { waitUntil: 'networkidle' })
  return page
}

async function fetchHistory(appPage) {
  return appPage.evaluate(async () => {
    const res = await fetch('/api/gacha-history?perPage=10', { credentials: 'include', cache: 'no-store' })
    if (!res.ok) return { status: res.status, rows: [] }
    const body = await res.json()
    const rows = (body.history ?? []).map((row) => ({
      id: row.id,
      card: row.cards?.name ?? null,
      rarity: row.cards?.rarity ?? null,
      user: row.user_twitch_username ?? null,
      redeemedAt: row.redeemed_at ?? null,
    }))
    return { status: res.status, rows }
  })
}

async function waitNewHistory(appPage, knownIds, user, sinceMs) {
  const deadline = Date.now() + HISTORY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const { rows } = await fetchHistory(appPage)
    const fresh = rows.filter((row) => !knownIds.has(row.id) &&
      row.user?.toLowerCase() === user && Date.parse(row.redeemedAt) >= sinceMs - HISTORY_SKEW_MS)
    if (fresh.length > 0) return fresh
    await sleep(2_000)
  }
  return []
}

// ---- Twitch popout chat ---------------------------------------------------

async function openChat(context, channel) {
  const page = await context.newPage()
  await page.goto(`https://www.twitch.tv/popout/${channel}/chat`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-a-target="chat-input"]').first().waitFor({ timeout: 30_000 })
  return page
}

// DOM identity, rather than list length/text, survives Twitch pruning old chat rows and
// distinguishes consecutive identical card announcements. Existing nodes are never reused.
async function chatLines(page) {
  return page.evaluate(() => {
    window.__twicaChatSequence ??= 0
    return [...document.querySelectorAll('[data-a-target="chat-line-message"], .chat-line__message')].map((el) => {
      el.dataset.twicaChatId ??= String(++window.__twicaChatSequence)
      return { id: el.dataset.twicaChatId, text: el.innerText.replace(/\s+/g, ' ').trim() }
    })
  })
}

function chatMatches(line, row, user) {
  // The standard announcement includes both the recipient and the full card name.
  // Custom templates lacking these fields are intentionally not sufficient evidence.
  return Boolean(line && row?.card && line.toLowerCase().includes(`@${user} `) &&
    line.includes(`】${row.card} を獲得しました！`))
}

// 基準を取る前にチャット描画が落ち着くまで待つ。Twitch が過去メッセージを遅れて描画
// したり既存行の DOM を作り直したりすると、遅れて出た前の交換の通知を今回の通知と
// 取り違える。新しい行 id が連続して現れなくなってから基準を取る。
async function waitChatSettled(page, quietMs = 2_000, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const seen = new Set()
  let lastNewAt = Date.now()
  while (Date.now() < deadline) {
    const lines = await chatLines(page)
    const added = lines.filter((line) => !seen.has(line.id))
    if (added.length > 0) {
      added.forEach((line) => seen.add(line.id))
      lastNewAt = Date.now()
    }
    if (Date.now() - lastNewAt >= quietMs) return seen
    await sleep(500)
  }
  return seen
}

// 一致する新しい行が「1件だけ」であることを条件にする。前の通知の重複送信などで
// 2件以上一致した場合は取り違えの可能性があるため、不合格側に倒す。
async function waitChatLines(page, baseline, row, user) {
  const deadline = Date.now() + CHAT_TIMEOUT_MS
  const matches = new Map()
  let firstMatchAt = 0
  while (Date.now() < deadline) {
    for (const line of await chatLines(page)) {
      if (!baseline.has(line.id) && !matches.has(line.id) && chatMatches(line.text, row, user)) {
        matches.set(line.id, line.text)
        firstMatchAt ||= Date.now()
      }
    }
    // 最初の一致後も短く観測を続け、遅れて届く重複通知を件数に含める。
    if (firstMatchAt && Date.now() - firstMatchAt >= 4_000) break
    await sleep(1_000)
  }
  return [...matches.values()]
}

// Only an unambiguous new display and history for this user/time window can pass.
// A simultaneous draw by the same user is ambiguous, so fail rather than guessing.
function correlateRedemption(samples, rows, user, sinceMs, previousInstances) {
  const fresh = rows.filter((row) => row.user?.toLowerCase() === user && Date.parse(row.redeemedAt) >= sinceMs - HISTORY_SKEW_MS)
  if (fresh.length !== 1) return null
  const row = fresh[0]
  // instance 番号はリロードで振り直されるため世代（epoch）込みで照合する。
  // epoch の無い sample（古い記録形式）は instance だけで照合する。
  const keyOf = (sample) => (sample.epoch ? `${sample.epoch}:${sample.instance}` : sample.instance)
  const displays = samples.filter((sample) => sample.instance && !previousInstances.has(keyOf(sample)) &&
    sample.observedAt >= sinceMs && sample.user?.toLowerCase() === user && sample.card === row.card)
  return displays.length === 1 ? { history: row, overlay: displays[0] } : null
}

async function openRewardDetail(page, reward) {
  const pointsButton = page
    .locator('[data-test-selector="community-points-summary"] button')
    .or(page.getByRole('button', { name: /ビッツとポイント|Bits and Points/ }))
    .first()
  await pointsButton.click()
  // 初回だけ「パワーアップ＆報酬」の案内カードが報酬一覧の代わりに出る（ポイントは消費しない）。
  const onboarding = page.getByRole('button', { name: /早速始めましょう|Get Started/ })
  if (await onboarding.isVisible({ timeout: 3_000 }).catch(() => false)) await onboarding.click()
  // 報酬が Twitch 側で無効（is_enabled=false）だと一覧に出ない。報酬名はタイルの下の
  // ラベルで、押せるのはコストを表示したタイル本体の button なので、両方を含む最小の要素から辿る。
  const title = page.getByText(reward, { exact: true })
  await title.first().waitFor({ timeout: 10_000 })
  await page.locator('div', { has: title }).filter({ has: page.locator('button') }).last().locator('button').first().click()
  // 確認画面の交換ボタン（例: 「交換 10」）。押すのは run のときだけ。
  const redeem = page.getByRole('dialog').getByRole('button', { name: /^(交換|Redeem)/ }).last()
  await redeem.waitFor({ timeout: 10_000 })
  // 別の報酬の確認画面で押さないよう、確認画面に対象の報酬名があることを確かめる。
  await page.getByRole('dialog').getByText(reward, { exact: true }).last().waitFor({ timeout: 5_000 })
  await page.waitForTimeout(800) // 開くアニメーションの途中で撮影しない
  return redeem
}

// ---- Worker logs (wrangler tail) ------------------------------------------

const TAIL_WORKERS = ['twica-preview', 'twica-overlay-realtime-preview', 'twica-chat-delivery-preview']

// tail の event にはリクエストヘッダー（Cookie、EventSub 署名など）が入るため、
// ヘッダーは捨て、Worker 名・結果・パス・ステータス・ログ本文・例外だけを残す。
function redactTailEvent(event) {
  let path = null
  try {
    path = event.event?.request?.url ? new URL(event.event.request.url).pathname : null
  } catch {
    path = null
  }
  return {
    worker: event.scriptName,
    at: event.eventTimestamp ? new Date(event.eventTimestamp).toISOString() : null,
    outcome: event.outcome,
    method: event.event?.request?.method ?? null,
    path,
    status: event.event?.response?.status ?? null,
    queue: event.event?.queue ?? null,
    cron: event.event?.cron ?? null,
    logs: (event.logs ?? []).map((log) => `${log.level}: ${JSON.stringify(log.message).slice(0, 400)}`),
    exceptions: (event.exceptions ?? []).map((ex) => `${ex.name}: ${String(ex.message).slice(0, 300)}`),
  }
}

// `wrangler tail --format json` は 1 event ごとに整形済み JSON を出力し、chunk の境界は
// event の境界と一致しない。トップレベルの { } が閉じた所で区切り、残りは次の chunk へ回す。
function splitJsonObjects(buffer) {
  const objects = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  let consumed = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const c = buffer[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (c === '}' && depth > 0) {
      depth -= 1
      if (depth === 0) {
        objects.push(buffer.slice(start, i + 1))
        consumed = i + 1
      }
    }
  }
  return { objects, rest: buffer.slice(consumed) }
}

const tailChildren = new Set()
let tailCleanupRegistered = false
// 中断（SIGINT 等）でも途中までの result.json を残せるよう、実行中の結果を持ち回る。
const pendingResult = { out: null, result: null }
// signal ハンドラーから正常終了を試みるため、起動中のブラウザを持ち回る。
let activeContext = null

// npx が先に終了して wrangler の cli がグループに残ることがある。直接の子の生死ではなく
// プロセスグループ自体の有無で送り先を決める（kill(-pid, 0) は ESRCH で消滅を示す）。
function tailGroupAlive(child) {
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// wrangler tail は npx → wrangler.js → cli の多段で起動し、SIGKILL は子へ転送されない。
// 独立したプロセスグループで起動し（detached）、グループごと signal を送って孤児にしない。
function killTail(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    // 既に終了している
  }
}

// 異常終了しても wrangler tail を孤児にしない。tail は別グループのため端末の Ctrl+C が
// 直接は届かないので、ハーネスが受けた signal でも exit（→ グループ kill）させる。
// テストで import しただけでは登録しないよう、最初の tail 起動時に登録する。
function registerTailCleanup() {
  if (tailCleanupRegistered) return
  tailCleanupRegistered = true
  process.on('exit', () => {
    // 子プロセス自体は exit 済みでもグループに残った cli だけを拾うため、グループの
    // 生死を確認してから送る。消えたグループへの遅れ SIGKILL（PID 再利用への誤爆）を防ぐ。
    for (const child of tailChildren) {
      if (tailGroupAlive(child)) killTail(child, 'SIGKILL')
    }
    // SIGTERM / SIGHUP で即 exit すると result.json が残らず、途中まで行った実交換の
    // 記録が失われる。pending の結果があれば interrupted 印を付けて書き出す。
    if (pendingResult.out && pendingResult.result) {
      try {
        writeFileSync(join(pendingResult.out, 'result.json'),
          JSON.stringify({ ...pendingResult.result, interrupted: true, finishedAt: now() }, null, 2))
      } catch {
        // 書き出せない場合は何もしない（exit ハンドラー内では投げられない）
      }
    }
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      // Playwright が Chrome を正常に閉じる前に exit すると専用プロファイルの Chrome が
      // 強制終了される。上限 3 秒だけ正常終了を待ってから exit する。
      const closing = activeContext
        ? Promise.race([activeContext.close().catch(() => {}), sleep(3_000)])
        : Promise.resolve()
      closing.finally(() => process.exit(128 + osConstants.signals[signal]))
    })
  }
}

function startTail(worker) {
  // リポジトリの devDependency の wrangler を使う。
  registerTailCleanup()
  const child = spawn('npx', ['wrangler', 'tail', worker, '--format', 'json'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  // exit 後も消さずに保持する。npx だけが終了して wrangler cli がグループに残った
  // 場合、exit ハンドラーがグループごと回収できるようにするため。
  tailChildren.add(child)
  const tail = { worker, events: [], stderr: '', child, failed: false }
  // Latch failures: later output or a successful HTTP event cannot repair a gap in observation.
  child.on('error', () => { tail.failed = true })
  child.on('exit', () => { tail.failed = true })
  let buffer = ''
  // chunk 境界でマルチバイト文字（日本語ログ）が壊れないよう、decoder に任せる。
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    const { objects, rest } = splitJsonObjects(buffer + chunk)
    buffer = rest
    for (const text of objects) {
      try {
        tail.events.push(redactTailEvent(JSON.parse(text)))
      } catch {
        tail.failed = true // A discarded event could contain the error the gate must detect.
      }
    }
  })
  // stdout と同様に utf8 でデコードする。生の chunk 連結だとマルチバイト文字の
  // 境界で「✘」が分断され、失敗検知を見落とす可能性がある。
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    tail.stderr = (tail.stderr + chunk).slice(-2_000)
    if (/error|✘|reconnect|disconnect|closed unexpectedly/i.test(tail.stderr)) tail.failed = true
  })
  return tail
}

async function stopTails(tails) {
  for (const tail of tails) {
    if (tailGroupAlive(tail.child)) killTail(tail.child, 'SIGINT')
  }
  await sleep(1_000)
  for (const tail of tails) {
    if (tailGroupAlive(tail.child)) killTail(tail.child, 'SIGKILL')
  }
}

function tailAlive(tail) {
  return !tail.failed && tail.child?.exitCode === null && tail.child?.signalCode === null && !tail.child?.killed
}

async function waitTailsReady(tails, probe) {
  if (tails.length === 0) return
  // JSON mode has no connection banner. An actual event is the only positive readiness
  // evidence; chat-delivery's minute cron also allows this without a paid redemption.
  const deadline = Date.now() + 90_000
  let nextProbeAt = 0
  while (Date.now() < deadline) {
    if (!tails.every(tailAlive)) throw new Error('Worker tail stopped before redemption')
    if (tails.every((tail) => tail.events.length > 0)) return
    // A request made before wrangler attaches is lost. Repeat ordinary page requests
    // until receipt is proven instead of relying on a fixed delay.
    if (Date.now() >= nextProbeAt) {
      await probe()
      nextProbeAt = Date.now() + 10_000
    }
    await sleep(500)
  }
  throw new Error('Worker tail readiness unverified: no event received from every Worker')
}

async function probeTailReadiness(tails, overlay, appPage) {
  const overlayTail = tails.find((tail) => tail.worker === 'twica-overlay-realtime-preview')
  if (overlayTail && overlayTail.events.length === 0) {
    // A WebSocket tail event may not arrive until that request closes. Reload only
    // before any redemption, which closes the earlier socket and performs the normal
    // browser connection again without reading tokens or calling internal endpoints.
    // The same tab is then retained throughout every actual redemption.
    await overlay.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
    await overlay.getByText(/Status: connected/).waitFor({ timeout: 15_000 })
  }
  const history = await fetchHistory(appPage)
  if (history.status !== 200) throw new Error(`Readiness history GET returned ${history.status}`)
}

function isCanceledAfterResponse(event) {
  return event.outcome === 'canceled' && event.status >= 200 && event.status < 300 &&
    PUBLISH_PATH.test(event.path ?? '')
}

function summarizeTails(tails) {
  const events = tails.flatMap((tail) => tail.events)
  const text = (event) => [...event.logs, ...event.exceptions].join('\n')
  return {
    connected: Object.fromEntries(tails.map((tail) => [tail.worker, tailAlive(tail) && tail.events.length > 0])),
    events: Object.fromEntries(tails.map((tail) => [tail.worker, tail.events.length])),
    eventsub: events.filter((event) => event.path === '/api/twitch/eventsub').map((event) => ({ at: event.at, status: event.status, outcome: event.outcome })),
    redemptionLogs: events.filter((event) => /channel_points_custom_reward_redemption/.test(text(event))).length,
    chatSentLogs: events.filter((event) => /Chat message sent/i.test(text(event))).length,
    retryLogs: events.filter((event) => /retry|retrying|parked|stall/i.test(text(event))).map((event) => ({ worker: event.worker, at: event.at, logs: event.logs.slice(0, 3) })),
    // 呼び出し元が status だけ読んで本文を cancel すると（src/lib/overlay-realtime/publisher.ts の
    // discardResponseBody）、呼ばれた側は 2xx を返していても outcome=canceled になる。
    // 応答を返し終えた後の cancel は失敗ではないため、別枠に記録するだけにする。
    canceledAfterResponse: events.filter(isCanceledAfterResponse).map((event) => ({ worker: event.worker, at: event.at, path: event.path, status: event.status })),
    nonOk: events.filter((event) => event.outcome && event.outcome !== 'ok' && !isCanceledAfterResponse(event)).map((event) => ({ worker: event.worker, at: event.at, outcome: event.outcome, path: event.path, status: event.status })),
    errorLogs: events.filter((event) => event.exceptions.length > 0 || event.logs.some((log) => log.startsWith('error'))).map((event) => ({ worker: event.worker, at: event.at, path: event.path, logs: event.logs.filter((log) => log.startsWith('error')).slice(0, 3), exceptions: event.exceptions })),
    http5xx: events.filter((event) => event.status >= 500).map((event) => ({ worker: event.worker, at: event.at, path: event.path, status: event.status })),
  }
}

// ---- commands -------------------------------------------------------------

// Twitch のログイン画面は自動操作中の Chrome を「未対応のブラウザ」として拒否する。
// 検知の回避はせず、ログインだけは同じ専用プロファイルを通常起動した Chrome で人が行い、
// check / run はそこで保存されたセッションを再利用する。
function login() {
  mkdirSync(PROFILE, { recursive: true })
  const child = spawn(
    'open',
    ['-na', 'Google Chrome', '--args', `--user-data-dir=${PROFILE}`, '--no-first-run',
      'https://www.twitch.tv/login', `${APP}/`],
    { stdio: 'inherit' },
  )
  child.on('exit', (code) => {
    console.log('専用プロファイルの Chrome を通常起動しました。')
    console.log('(1) Twitch にログイン、(2) preview の TwiCa に Twitch でログインしたら、')
    console.log('その Chrome を Cmd+Q で終了してください（プロファイルのロックを外すため）。')
    process.exitCode = code ?? 0
  })
}

async function check(opts, out) {
  registerTailCleanup()
  const context = await launch()
  const result = { mode: 'check', startedAt: now(), opts, checks: {} }
  pendingResult.out = out
  pendingResult.result = result
  // 例外で終わっても「Worker ログ未確認」だったことが分かるよう先に印を付ける。
  if (opts.logs === 'off') result.logs = 'skipped'
  const tails = opts.logs === 'on' ? TAIL_WORKERS.map(startTail) : []
  try {
    const overlay = await openOverlay(context, opts.streamerId)
    result.checks.overlayConnected = true
    const app = await openApp(context)
    const history = await fetchHistory(app)
    result.checks.historyApi = { status: history.status, rows: history.rows.length }
    const chat = await openChat(context, opts.channel)
    result.checks.chatReady = true
    await waitTailsReady(tails, () => probeTailReadiness(tails, overlay, app))
    await openRewardDetail(chat, opts.reward)
    result.checks.rewardDetailOpened = true
    await chat.screenshot({ path: join(out, 'check-reward-detail.png') })
    await overlay.screenshot({ path: join(out, 'check-overlay.png') })
    await chat.keyboard.press('Escape')
    if (tails.length > 0) {
      await sleep(5_000)
      // プロセスが生きているだけでは受信の証拠にならないため、受信 event 数も残す。
      // check でも overlay と dashboard を開くので、少なくとも app Worker には event が届く。
      result.checks.tail = Object.fromEntries(tails.map((tail) => [tail.worker, {
        alive: tailAlive(tail) && tail.events.length > 0,
        events: tail.events.length,
        stderr: tail.stderr.trim().slice(-200) || null,
      }]))
    }
    // tail.alive には受信 event 数 > 0 が既に含まれるため二重に判定しない。
    result.ok = history.status === 200 &&
      Object.values(result.checks.tail ?? {}).every((t) => t.alive)
  } catch (error) {
    result.ok = false
    result.error = String(error?.message ?? error).slice(0, 500)
    for (const [i, page] of context.pages().entries()) {
      await page.screenshot({ path: join(out, `check-error-${i}.png`) }).catch(() => {})
    }
  } finally {
    result.finishedAt = now()
    await stopTails(tails)
    await context.close()
  }
  return result
}

async function run(opts, out) {
  registerTailCleanup()
  const context = await launch()
  const result = { mode: 'run', startedAt: now(), opts, redemptions: [] }
  pendingResult.out = out
  pendingResult.result = result
  // 例外で終わっても「Worker ログ未確認」だったことが分かるよう先に印を付ける。
  if (opts.logs === 'off') result.logs = 'skipped'
  const tails = opts.logs === 'on' ? TAIL_WORKERS.map(startTail) : []
  try {
    const overlay = await openOverlay(context, opts.streamerId)
    const app = await openApp(context)
    const initial = await fetchHistory(app)
    if (initial.status !== 200) throw new Error(`gacha-history API returned ${initial.status}（preview に未ログインの可能性）`)
    const knownIds = new Set(initial.rows.map((row) => row.id))
    const chat = await openChat(context, opts.channel)
    await waitTailsReady(tails, () => probeTailReadiness(tails, overlay, app))
    const runLogOffsets = tails.map((tail) => tail.events.length)
    const previousInstances = new Set()
    let overlayEpochSeen = await overlayEpoch(overlay)
    let previousCard = null

    for (let n = 1; n <= opts.count; n += 1) {
      const entry = { n }
      // 2回目以降は overlay が観測を続けていることを交換前に再確認する（QA の接続ゲート）。
      if (n > 1) {
        await overlay.getByText(/Status: connected/).waitFor({ timeout: 15_000 })
        entry.overlayConnectedBefore = true
      }
      // 基準を取る前にチャット描画が落ち着くまで待ち、遅れて届く前回通知との取り違えを防ぐ。
      const baseline = await waitChatSettled(chat)
      const redeem = await openRewardDetail(chat, opts.reward)
      const before = await fetchHistory(app)
      if (before.status !== 200) throw new Error('Cannot establish pre-redemption history baseline')
      before.rows.forEach((row) => knownIds.add(row.id))
      // overlay がリロードされると instance 番号が振り直される。世代が変わっていれば
      // 「既出 instance」の記録は意味をなさないので破棄し、リロードを結果に記録する。
      const epoch = await overlayEpoch(overlay)
      if (epoch !== overlayEpochSeen) {
        previousInstances.clear()
        overlayEpochSeen = epoch
        entry.overlayReloaded = true
      }
      const oldInstance = await overlay.locator('[data-overlay-card="true"]').getAttribute('data-overlay-display-instance', { timeout: 500 }).catch(() => null)
      if (oldInstance) previousInstances.add(`${epoch}:${oldInstance}`)
      if (!tails.every(tailAlive)) throw new Error('Worker tail stopped before redemption')
      const logOffsets = tails.map((tail) => tail.events.length)
      // 確認画面が開いてからここまで約1秒あるため、別の報酬へ変わっていないか押す直前に再確認する。
      await chat.getByRole('dialog').getByText(opts.reward, { exact: true }).last().waitFor({ timeout: 3_000 })
      const clickedAt = Date.now()
      entry.redeemedAt = new Date(clickedAt).toISOString()
      // Start sampling before the click, then keep collecting while history/chat are read.
      const observation = observeOverlayCards(overlay, clickedAt, previousInstances, out, n).catch(() => ({ samples: [], epoch }))
      await redeem.click()
      await chat.screenshot({ path: join(out, `${n}-twitch-redeemed.png`) })

      const waited = await waitNewHistory(app, knownIds, opts.user, clickedAt)
      const { samples } = await observation
      // Re-read after the observation window so concurrent draws cannot be hidden by
      // accepting only the first row that happened to arrive.
      const after = await fetchHistory(app)
      if (after.status !== 200) throw new Error('Cannot verify post-redemption history')
      const fresh = after.rows.filter((row) => !knownIds.has(row.id))
      fresh.forEach((row) => knownIds.add(row.id))
      const correlated = correlateRedemption(samples, fresh, opts.user, clickedAt, previousInstances)
      samples.forEach((sample) => previousInstances.add(`${sample.epoch}:${sample.instance}`))
      entry.history = fresh
      entry.historyFirst = waited.map((row) => row.id)
      entry.overlay = correlated?.overlay ?? null
      const cardName = correlated?.history.card
      // 前の交換と同じカード名なら、チャット照合の取り違え余地として結果に記録する。
      entry.sameCardAsPrevious = previousCard !== null && cardName === previousCard
      if (cardName) previousCard = cardName
      const chatHits = correlated ? await waitChatLines(chat, baseline, correlated.history, opts.user) : []
      entry.chatMatchCount = chatHits.length
      entry.chat = chatHits.length === 1 ? chatHits[0] : null
      entry.workerEvents = Object.fromEntries(tails.map((tail, i) => [tail.worker, tail.events.length - logOffsets[i]]))
      await chat.screenshot({ path: join(out, `${n}-chat.png`) })
      await chat.keyboard.press('Escape').catch(() => {})

      // latencyOk は QA の表示までの目安（2〜5 秒）の判定。overlay が無い場合は既に不合格。
      entry.ok = Boolean(correlated && correlated.overlay.latencyOk && entry.chat)
      result.redemptions.push(entry)
      console.log(`#${n}: overlay=${Boolean(entry.overlay)} history=${fresh.length} chat=${Boolean(entry.chat)} card=${cardName ?? '-'}`)
      // 交換単位を識別できるよう間隔を空ける。
      if (n < opts.count) await sleep(8_000)
    }
    result.ok = result.redemptions.length === opts.count && result.redemptions.every((entry) => entry.ok)
    if (tails.length > 0) {
      await sleep(15_000) // chat 配信や overlay の遅れて届く event を拾う
      const logs = summarizeTails(tails.map((tail, i) => ({ ...tail, events: tail.events.slice(runLogOffsets[i]) })))
      logs.ok =
        Object.values(logs.connected).every(Boolean) &&
        logs.eventsub.filter((event) => event.status === 200).length >= opts.count &&
        logs.nonOk.length === 0 && logs.errorLogs.length === 0 && logs.http5xx.length === 0 && logs.retryLogs.length === 0
      result.logs = logs
      writeFileSync(join(out, 'worker-logs.json'), JSON.stringify(tails.map(({ worker, events }) => ({ worker, events })), null, 2))
      result.ok = result.ok && logs.ok
    } else {
      // QA の実経路ゲートは Worker ログの確認を含むため、省略したことを結果に残す。
      console.log('Worker ログ未確認（--logs off）: QA の実経路ゲートの証拠としては不足')
    }
  } catch (error) {
    result.ok = false
    result.error = String(error?.message ?? error).slice(0, 500)
    for (const [i, page] of context.pages().entries()) {
      await page.screenshot({ path: join(out, `run-error-${i}.png`) }).catch(() => {})
    }
  } finally {
    result.finishedAt = now()
    await stopTails(tails)
    await context.close()
  }
  return result
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2))
  if (command === 'login') {
    login()
  } else if (command === 'check' || command === 'run') {
    const out = join(HOME, 'runs', `${now().replace(/[:.]/g, '-')}-${command}`)
    mkdirSync(out, { recursive: true })
    const result = command === 'check' ? await check(opts, out) : await run(opts, out)
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
    pendingResult.out = null
    pendingResult.result = null
    console.log(JSON.stringify(result, null, 2))
    console.log(`output: ${out}`)
    process.exitCode = result.ok ? 0 : 1
  } else {
    console.error('usage: npm run e2e:preview-redemption -- <login|check|run> [--count N] [--channel login] [--reward title] [--user displayName] [--streamerId uuid] [--logs on|off]')
    process.exitCode = 2
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}

export { parseArgs, redactTailEvent, splitJsonObjects, summarizeTails, correlateRedemption, chatMatches, tailAlive, waitTailsReady }
