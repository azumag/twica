/**
 * Reporter Cron Worker (twica-error-reporter)
 * レポーター定期実行Worker
 *
 * 5分ごとに Supabase をポーリングし、2種類の未処理レコードを GitHub Issue 化する:
 *   1. errors           … アプリで捕捉した未処理エラー（シグネチャで重複排除）
 *   2. support_inquiries … 支援者からの新規問い合わせ（メンテナへの通知）
 *
 * いずれも同じ Transactional Outbox パターン（Supabase をアウトボックスとして
 * 使い、処理済みフラグでリトライ・重複を制御）。GitHub / Supabase REST の薄い
 * ラッパを共通ヘルパとして両処理で共有する。単一 Worker に集約することで、
 * secrets・cron・デプロイを1組で済ませ運用を単純化する。
 *
 * Tail Workers (有料プラン必須) の無料代替として実装。
 * Cloudflare Workers Free プランの Cron Triggers を使用。
 *
 * See: https://github.com/azumag/twica/issues/239 (errors)
 *      https://github.com/azumag/twica/issues/633 (inquiries)
 */

/** GitHub API 呼び出し時の User-Agent（GitHub は User-Agent 必須） */
const USER_AGENT = 'twica-error-reporter'

interface Env {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  GITHUB_TOKEN: string
  GITHUB_REPO_OWNER: string
  GITHUB_REPO_NAME: string
  /**
   * Issue #695 の代替として承認された KV ベース部分改善の1項目目
   * （EventSub 退避 backlog の監視）で使う KV namespace binding。
   * root wrangler.toml と同じ namespace（id は wrangler.toml 参照）を
   * binding 名 RATE_LIMIT_KV で共用する。このワーカーはキー名の一覧
   * （list）だけを読み、値（get）には触れない。
   *
   * 相互参照（ドリフト防止）: このバインディングで前提にしているキー形式
   * `maintenance:eventsub:<ISO8601受信時刻>:<messageId>` は
   * src/lib/maintenance/eventsub-park.ts の KEY_PREFIX 定義が唯一の
   * ソースであり、このファイルはそれを独立に再実装したものにすぎない
   * （このワーカーパッケージは @/lib/maintenance/eventsub-park.ts を
   * 直接 import できない構成のため）。片方のキー形式を変更したら、
   * 必ずもう片方（EVENTSUB_PARK_KEY_PATTERN 以下）も確認・追従すること。
   *
   * optional にしている理由: wrangler.toml の設定漏れ・古い環境等で binding が
   * 無いケースを型レベルでも許容し、processEventSubParkBacklog 内の defensive
   * チェック（他の secrets と違い早期 return せず個別に no-op する）と対応させる。
   */
  RATE_LIMIT_KV?: EventSubParkKVNamespace
}

/**
 * Cloudflare Workers KV namespace の最小インターフェース。
 * @cloudflare/workers-types のグローバル `KVNamespace` 型はあえて使わない
 * （src/lib/maintenance/eventsub-park.ts の KVNamespaceLike と同じ方針）。
 * 理由: このファイルはルート tsconfig.json の exclude 対象だが、
 * tests/unit/error-reporter-worker.test.ts からの import 経由でルートの
 * `tsc --noEmit` の型チェック対象グラフに入る。ルート側には
 * @cloudflare/workers-types が入っていないため、グローバル型に依存すると
 * ルートの typecheck が壊れる。実際に使う list() だけを最小定義することで
 * この依存を断ち切る。
 */
interface EventSubParkKVNamespace {
  /**
   * cursor は Major-1 対応（tombstone 追従の cursor ページネーション）で追加。
   * 戻り値の cursor は list_complete=false の場合に次回呼び出しへ渡す
   * （Cloudflare Workers KV のページネーション仕様どおり）。
   */
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[]
    list_complete: boolean
    cursor?: string
  }>
}

// =============================================================================
// 共通ヘルパ: Supabase REST (PostgREST)
// Supabase JS クライアントは使わず fetch で直接叩く（バンドルサイズ最小化）。
// service_role 相当のキーで RLS を越えてサーバーサイド専用アクセスする。
// =============================================================================

/** secret キーを解決する（新キー優先、無ければ旧 service role キー） */
function getSupabaseApiKey(env: Env): string | undefined {
  return env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY
}

/**
 * PostgREST の GET でレコードを取得する。
 * @param pathAndQuery /rest/v1/ 以降のパス + クエリ
 */
async function supabaseSelect<T>(env: Env, pathAndQuery: string): Promise<T> {
  const key = getSupabaseApiKey(env)
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    headers: {
      'apikey': key!,
      'Authorization': `Bearer ${key}`,
      'Accept': 'application/json',
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase fetch error: ${res.status} ${text}`)
  }

  return (await res.json()) as T
}

/**
 * PostgREST の PATCH でレコードを更新する（Prefer: return=minimal）。
 * @param pathAndQuery /rest/v1/ 以降のパス + フィルタ
 * @param body 更新する列の値
 */
async function supabasePatch(
  env: Env,
  pathAndQuery: string,
  body: Record<string, unknown>
): Promise<void> {
  const key = getSupabaseApiKey(env)
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method: 'PATCH',
    headers: {
      'apikey': key!,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase PATCH error: ${res.status} ${text}`)
  }
}

// =============================================================================
// 共通ヘルパ: GitHub Issues API
// @octokit は使わず raw fetch（バンドルサイズ最小化）。
// =============================================================================

/** GitHub API 共通ヘッダ。json=true で Content-Type を付与。 */
function githubHeaders(env: Env, json = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': USER_AGENT,
  }
  if (json) {
    headers['Content-Type'] = 'application/json'
  }
  return headers
}

/**
 * GitHub Issues Search API で既存 Issue を検索する。
 * Issue 本文に埋め込んだマーカー（Signature / Inquiry-ID 等）で照合し、
 * 重複作成を防止する。API 失敗時は例外を投げず null を返す。
 *
 * 検索は best-effort（GitHub の検索インデックスは非同期更新のため、作成直後の
 * Issue はヒットしないことがある）。冪等性の本命は呼び出し元の処理済みフラグ。
 */
async function searchIssue(
  env: Env,
  query: string
): Promise<{ number: number; url: string } | null> {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: githubHeaders(env) })

  if (!res.ok) {
    console.warn(`[Reporter] GitHub search API failed: ${res.status}`)
    return null
  }

  const data = (await res.json()) as {
    total_count: number
    items: Array<{ number: number; html_url: string }>
  }
  if (data.total_count > 0) {
    return { number: data.items[0].number, url: data.items[0].html_url }
  }
  return null
}

/**
 * GitHub Issue を新規作成する。
 * @throws API がエラーを返した場合（呼び出し元で処理済みマークをスキップさせる）
 */
async function postGitHubIssue(
  env: Env,
  payload: { title: string; body: string; labels: string[] }
): Promise<{ number: number; url: string }> {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues`,
    {
      method: 'POST',
      headers: githubHeaders(env, true),
      body: JSON.stringify(payload),
    }
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API error: ${res.status} ${text}`)
  }

  const issue = (await res.json()) as { number: number; html_url: string }
  return { number: issue.number, url: issue.html_url }
}

/**
 * 既存 Issue にコメントを追加する。
 * @throws API がエラーを返した場合
 */
async function postIssueComment(env: Env, issueNumber: number, body: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: githubHeaders(env, true),
      body: JSON.stringify({ body }),
    }
  )

  if (!res.ok) {
    throw new Error(`Failed to add comment to issue #${issueNumber}: ${res.status}`)
  }
}

// =============================================================================
// エラー処理（errors テーブル → GitHub Issue）
// =============================================================================

/** Supabase errors テーブルのレコード型 */
interface ErrorRecord {
  id: string
  error_type: string
  message: string
  stack_trace: string | null
  context: Record<string, unknown>
  environment: string
  created_at: string
}

/** 同一シグネチャのエラーをまとめたグループ */
interface ErrorGroup {
  signature: string
  errors: ErrorRecord[]
  count: number
  firstSeen: string
  lastSeen: string
}

/**
 * エラーシグネチャを生成する。
 * error_type + message の先頭行 + スタックトレースの先頭行 を組み合わせ、
 * 同一のエラーを1つの GitHub Issue にまとめるために使用。
 * SHA-256 で固定長ハッシュにし、Issue 本文内での検索・照合を容易にする。
 */
async function generateSignature(error: ErrorRecord): Promise<string> {
  const messageLine = error.message.split('\n')[0].slice(0, 200)
  const stackLine = error.stack_trace?.split('\n')[0]?.slice(0, 200) || ''
  const raw = `${error.error_type}:${messageLine}:${stackLine}`

  const encoder = new TextEncoder()
  const data = encoder.encode(raw)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  // 先頭16文字で十分な一意性を確保（衝突確率は無視できるレベル）
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** エラーをシグネチャでグループ化する（同一シグネチャは1つの Issue にまとめる）。 */
async function groupErrors(errors: ErrorRecord[]): Promise<ErrorGroup[]> {
  const groups = new Map<string, ErrorRecord[]>()

  for (const error of errors) {
    const sig = await generateSignature(error)
    if (!groups.has(sig)) {
      groups.set(sig, [])
    }
    groups.get(sig)!.push(error)
  }

  return Array.from(groups.entries()).map(([signature, errs]) => ({
    signature,
    errors: errs,
    count: errs.length,
    // errs は created_at ASC (FIFO) で取得されるため、最初=最古、最後=最新
    firstSeen: errs[0].created_at,
    lastSeen: errs[errs.length - 1].created_at,
  }))
}

/** 既存 Issue を Signature ハッシュで検索する（重複作成防止）。 */
async function findExistingErrorIssue(
  signature: string,
  env: Env
): Promise<{ number: number; url: string } | null> {
  const query = `repo:${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME} is:issue "Signature: ${signature}"`
  return searchIssue(env, query)
}

/**
 * GitHub Issue を新規作成する（エラー用）。
 * Signature は重複検索に使用されるため、フォーマットを変更しないこと。
 */
async function createErrorIssue(
  group: ErrorGroup,
  env: Env
): Promise<{ number: number; url: string }> {
  const first = group.errors[0]

  // タイトル: 環境 + エラー種別 + メッセージ先頭（最大80文字）
  const title = `[${first.environment}] ${first.error_type} ${first.message.split('\n')[0]}`.slice(0, 80)

  const body = `## Auto-generated Error Report

**Type**: \`${first.error_type}\`
**Environment**: ${first.environment}
**Occurrences**: ${group.count}x
**First Seen**: ${group.firstSeen}
**Last Seen**: ${group.lastSeen}

### Message
\`\`\`
${first.message.slice(0, 2000)}
\`\`\`

### Stack Trace
\`\`\`
${first.stack_trace?.slice(0, 3000) || 'N/A'}
\`\`\`

### Context
\`\`\`json
${JSON.stringify(first.context, null, 2).slice(0, 2000)}
\`\`\`

---
Signature: ${group.signature}
*Auto-generated by [twica-error-reporter](https://github.com/azumag/twica/issues/239)*`

  const labels = ['bug', 'auto-generated']
  if (first.environment !== 'production') {
    labels.push(first.environment)
  }

  return postGitHubIssue(env, { title, body, labels })
}

/** 既存 Issue にコメントを追加する（再発通知）。 */
async function addCommentToIssue(
  issueNumber: number,
  group: ErrorGroup,
  env: Env
): Promise<void> {
  const body = `## Error Recurrence

**New occurrences**: ${group.count}x
**Last Seen**: ${group.lastSeen}

This error has reoccurred. Please investigate if still unresolved.`

  // コメント追加失敗時は throw して markErrorsAsProcessed をスキップさせる
  // （throw しないと「処理済み」マークされ、GitHub Issue への追記が永久に失われる）。
  await postIssueComment(env, issueNumber, body)
}

/** errors テーブルのレコードを処理済みに更新する。 */
async function markErrorsAsProcessed(
  errorIds: string[],
  issueNumber: number,
  issueUrl: string,
  env: Env
): Promise<void> {
  await supabasePatch(env, `errors?id=in.(${errorIds.join(',')})`, {
    github_issue_created: true,
    github_issue_number: issueNumber,
    github_issue_url: issueUrl,
  })
}

/**
 * 未処理エラーを取得する。
 * github_issue_created = false を古い順（FIFO）で最大100件。
 * 古い順にすることで、上限到達時も古いエラーが飢餓状態にならない。
 */
async function fetchPendingErrors(env: Env): Promise<ErrorRecord[]> {
  return supabaseSelect<ErrorRecord[]>(
    env,
    'errors?github_issue_created=eq.false&order=created_at.asc&limit=100'
  )
}

/**
 * エラー処理本体。
 * 1. 未処理エラーを取得 → 2. シグネチャでグループ化 → 3. 既存 Issue 検索
 *    （あり=コメント / なし=新規作成）→ 4. 処理済みマーク。
 */
export async function processErrors(env: Env): Promise<void> {
  console.log('[Error Reporter] Started')

  const errors = await fetchPendingErrors(env)
  if (errors.length === 0) {
    console.log('[Error Reporter] No pending errors')
    return
  }

  console.log(`[Error Reporter] Processing ${errors.length} errors`)

  const groups = await groupErrors(errors)
  console.log(`[Error Reporter] ${groups.length} unique error groups`)

  // 1回の実行で新規作成する Issue 数の上限（バースト時の Issue 乱立を防止）
  const MAX_NEW_ISSUES_PER_RUN = 5
  let newIssuesCreated = 0

  for (const group of groups) {
    try {
      const existing = await findExistingErrorIssue(group.signature, env)

      let issueNumber: number
      let issueUrl: string

      if (existing) {
        issueNumber = existing.number
        issueUrl = existing.url
        await addCommentToIssue(issueNumber, group, env)
        console.log(`[Error Reporter] Added comment to existing issue #${issueNumber}`)
      } else {
        if (newIssuesCreated >= MAX_NEW_ISSUES_PER_RUN) {
          console.log(`[Error Reporter] Max new issues limit (${MAX_NEW_ISSUES_PER_RUN}) reached. Deferring group: ${group.signature}`)
          continue
        }
        const issue = await createErrorIssue(group, env)
        issueNumber = issue.number
        issueUrl = issue.url
        newIssuesCreated++
        console.log(`[Error Reporter] Created issue #${issueNumber}: ${issueUrl}`)
      }

      const errorIds = group.errors.map(e => e.id)
      await markErrorsAsProcessed(errorIds, issueNumber, issueUrl, env)
    } catch (err) {
      // 個別グループのエラーは他のグループの処理を阻害しない
      console.error(`[Error Reporter] Failed to process group ${group.signature}:`, err)
    }
  }

  console.log(`[Error Reporter] Completed (${newIssuesCreated} new issues created)`)
}

// =============================================================================
// 問い合わせ処理（support_inquiries テーブル → GitHub Issue）
// error 処理との違い: 問い合わせは1件ずつ一意なのでグループ化・再発コメント不要。
// =============================================================================

/** Supabase support_inquiries テーブルのレコード型（Issue 化に必要な列のみ） */
interface InquiryRecord {
  id: string
  twitch_user_id: string
  twitch_display_name: string
  // 'bug' | 'feature' | 'other'
  category: string
  subject: string
  body: string
  created_at: string
}

/** fetchPendingInquiries で取得する列（InquiryRecord に対応。body 以外の余計な列は引かない） */
const INQUIRY_SELECT_COLUMNS = 'id,twitch_user_id,twitch_display_name,category,subject,body,created_at'

/**
 * 1回の実行で処理する問い合わせの最大件数。
 * Supabase fetch の limit にも使い、1件ごとに走る GitHub Search の回数を抑える。
 * 問い合わせは低頻度なので通常はほぼ 0 件。
 */
const MAX_INQUIRIES_PER_RUN = 10

/** カテゴリコード → 日本語表示名 */
const INQUIRY_CATEGORY_LABELS: Record<string, string> = {
  bug: 'バグ報告',
  feature: '機能要望',
  other: 'その他',
}

/** カテゴリの日本語表示名を返す（未知の値はそのままフォールバック） */
function inquiryCategoryLabel(category: string): string {
  return INQUIRY_CATEGORY_LABELS[category] ?? category
}

/**
 * 本文を安全にコードフェンスで囲む。
 * 本文中のバッククォート連の最大長 + 1 のフェンスを使うことで、本文から
 * フェンスを脱出して偽の `Inquiry-ID:` 行などを混入させる余地をなくす。
 */
function fenceInquiryBody(body: string): string {
  const runs = body.match(/`+/g)
  const longest = runs ? Math.max(...runs.map(r => r.length)) : 0
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${body}\n${fence}`
}

/**
 * ユーザー入力を安全なインラインコードスパンとして描画する。
 * 改行を空白へ畳んで1行に収め、markdown 描画（@メンションによる他ユーザーへの
 * 通知スパム・画像/リンク・整形崩し）や偽の見出し行の注入を無効化する。
 * 値に含まれるバッククォート連より1つ長いデリミタを使い、必要なら CommonMark に
 * 従いスペースパディングしてエスケープする。件名・表示名など fenced ブロック外に
 * 展開する自由入力フィールドに使う（本文は fenceInquiryBody で保護済み）。
 */
function inlineCode(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  const runs = collapsed.match(/`+/g)
  const ticks = '`'.repeat((runs ? Math.max(...runs.map(r => r.length)) : 0) + 1)
  // 先頭/末尾がバッククォートだとデリミタと隣接して壊れるためスペースパディング
  const needsPad = collapsed.startsWith('`') || collapsed.endsWith('`')
  const inner = needsPad ? ` ${collapsed} ` : collapsed
  return `${ticks}${inner}${ticks}`
}

/** 未処理問い合わせを取得する（FIFO・上限つき・必要列のみ）。 */
async function fetchPendingInquiries(env: Env): Promise<InquiryRecord[]> {
  return supabaseSelect<InquiryRecord[]>(
    env,
    `support_inquiries?select=${INQUIRY_SELECT_COLUMNS}&github_issue_created=eq.false&order=created_at.asc&limit=${MAX_INQUIRIES_PER_RUN}`
  )
}

/**
 * 問い合わせから GitHub Issue のペイロードを組み立てる。
 * リポジトリは private のためメンテナが対応に必要な投稿者情報も含める。
 * 末尾の `Inquiry-ID:` 行は重複検索のマーカーなのでフォーマットを変更しないこと。
 */
function buildInquiryIssue(inquiry: InquiryRecord): { title: string; body: string; labels: string[] } {
  const label = inquiryCategoryLabel(inquiry.category)
  // タイトル: 一覧で判別しやすい接頭辞 + 件名。改行を除去し120字上限に丸める。
  const singleLineSubject = inquiry.subject.replace(/\s+/g, ' ').trim()
  const title = `[問い合わせ/${label}] ${singleLineSubject}`.slice(0, 120)

  // fenced ブロック外に出す自由入力フィールドは inlineCode で無害化する
  // （投稿者による @メンション通知スパム・リンク/画像・偽の見出し行注入を防ぐ）。
  const body = `## 新規問い合わせ

**カテゴリ**: ${inlineCode(label)} (${inlineCode(inquiry.category)})
**投稿者**: ${inlineCode(inquiry.twitch_display_name)} (${inlineCode(inquiry.twitch_user_id)})
**件名**: ${inlineCode(inquiry.subject)}
**投稿日時**: ${inquiry.created_at}

### 本文
${fenceInquiryBody(inquiry.body)}

---
返信はダッシュボードの問い合わせ管理画面から行ってください。
Inquiry-ID: ${inquiry.id}
*Auto-generated by twica-error-reporter — https://github.com/azumag/twica/issues/633*`

  // 自動生成であることを明示するラベル（存在しなければ GitHub が自動作成する）。
  return { title, body, labels: ['support-inquiry', 'auto-generated'] }
}

/**
 * 問い合わせを処理済みに更新する（発行した Issue の番号・URL を記録）。
 * この PATCH は support_inquiries の update_support_inquiries_updated_at トリガ
 * (00019) を発火させ、対象行の updated_at を発行時刻に1度だけ書き換える。
 * ユーザー向け一覧・詳細は created_at ソートで updated_at に依存しないため実害は
 * 無いが、将来 updated_at を「最終更新」として表示する場合は考慮すること。
 */
async function markInquiryProcessed(
  id: string,
  issueNumber: number,
  issueUrl: string,
  env: Env
): Promise<void> {
  // id はサーバ生成 UUID だが、将来の型変更に対する防御として encode しておく
  await supabasePatch(env, `support_inquiries?id=eq.${encodeURIComponent(id)}`, {
    github_issue_created: true,
    github_issue_number: issueNumber,
    github_issue_url: issueUrl,
  })
}

/**
 * 問い合わせ処理本体。
 * 各件について既存 Issue を検索（冪等性の保険）→ 無ければ新規作成 →
 * 既存/新規いずれでも必ず処理済みマーク。
 */
export async function processInquiries(env: Env): Promise<void> {
  console.log('[Inquiry Reporter] Started')

  const inquiries = await fetchPendingInquiries(env)
  if (inquiries.length === 0) {
    console.log('[Inquiry Reporter] No pending inquiries')
    return
  }

  console.log(`[Inquiry Reporter] Processing ${inquiries.length} inquiries`)

  let created = 0

  for (const inquiry of inquiries) {
    try {
      // 冪等性の保険: 直前の実行で「作成成功 → 処理済みマーク失敗」となった場合に
      // 二重作成しないよう既存 Issue を検索する。本命の冪等性は github_issue_created
      // フラグ + create→mark の順序であり、検索は非同期インデックス依存の補助。
      // label:support-inquiry も条件に含め、無関係 Issue の本文に同じ文字列が
      // 偶然/意図的に含まれていた場合の誤マッチ面を減らす。
      const query = `repo:${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME} is:issue label:support-inquiry "Inquiry-ID: ${inquiry.id}"`
      const existing = await searchIssue(env, query)

      let issueNumber: number
      let issueUrl: string

      if (existing) {
        issueNumber = existing.number
        issueUrl = existing.url
        console.log(`[Inquiry Reporter] Existing issue #${issueNumber} found for inquiry ${inquiry.id}, skipping create`)
      } else {
        const issue = await postGitHubIssue(env, buildInquiryIssue(inquiry))
        issueNumber = issue.number
        issueUrl = issue.url
        created++
        console.log(`[Inquiry Reporter] Created issue #${issueNumber} for inquiry ${inquiry.id}: ${issueUrl}`)
      }

      // 既存・新規いずれの場合でも必ず処理済みマークする。
      // これを怠ると、既存 Issue があるのに github_issue_created=false のまま残り、
      // 毎回 GitHub Search を無駄に叩き続ける「飢餓 + 無限 search」状態に陥る。
      await markInquiryProcessed(inquiry.id, issueNumber, issueUrl, env)
    } catch (err) {
      // 個別問い合わせのエラーは他の問い合わせの処理を阻害しない
      console.error(`[Inquiry Reporter] Failed to process inquiry ${inquiry.id}:`, err)
    }
  }

  console.log(`[Inquiry Reporter] Completed (${created} new issues created)`)
}

// =============================================================================
// EventSub 退避 backlog 監視（RATE_LIMIT_KV → GitHub Issue）
//
// Issue #695（EventSub の Cloudflare Queue 化）の代替として承認された、
// KV ベース部分改善の1項目目。maintenance mode 中に退避された EventSub
// notification（src/lib/maintenance/eventsub-park.ts 参照）が、リプレイ
// 忘れ・maintenance mode 解除忘れ等で KV に滞留していないかを監視する。
//
// errors / support_inquiries との違い:
//   - 「処理済みフラグ」を持つ DB テーブルではなく、KV の現在時点の
//     スナップショット（キー一覧）を毎回読み直すだけ。そのため
//     「未処理を取得して処理済みにマークする」というトランザクショナル
//     アウトボックスの形は取れない。
//   - 値（get）は読まない。キー名 `maintenance:eventsub:<ISO8601受信時刻>:
//     <messageId>` から件数・最古受信時刻がそのまま分かるため、
//     KV 読み取り課金・レイテンシの両方を抑えられる（list のみで完結）。
// =============================================================================

/**
 * 退避データのキープレフィックス。
 * 相互参照: src/lib/maintenance/eventsub-park.ts の KEY_PREFIX 定数と
 * 完全に一致していなければならない。あちらを変更したらここも変更すること。
 *
 * ドリフトの機械的検知（Fable レビュー Major-3 対応）: export し、
 * tests/unit/error-reporter-worker.test.ts の契約テストで
 * src/lib/maintenance/eventsub-park.ts の export された KEY_PREFIX /
 * buildParkedEventSubKey と実際に一致するか（このワーカー独自実装が生成した
 * キーを本家の関数が作ったキーと突き合わせて）検証する。これによりコメントでの
 * 相互参照だけに頼らず、どちらかがドリフトしたらテストが赤くなるようにする。
 */
export const EVENTSUB_PARK_KEY_PREFIX = 'maintenance:eventsub:'

/**
 * プレフィックスを除いた残り部分（`<ISO8601受信時刻>:<messageId>`）の先頭が
 * ISO8601 タイムスタンプであることを検証しつつ、その部分だけを抽出する正規表現。
 * `Date.prototype.toISOString()` は常に `YYYY-MM-DDTHH:mm:ss.sssZ`
 * （ミリ秒3桁・末尾Z固定）の形式を返す仕様（ECMA-262）であることに依拠している。
 * 相互参照: src/lib/maintenance/eventsub-park.ts の
 * `${KEY_PREFIX}${receivedAt}:${input.messageId}` というキー組み立てと対。
 * あちらのキー形式（区切り文字・時刻フォーマット）を変更したら、この正規表現も
 * 追従して変更すること。
 */
const EVENTSUB_PARK_RECEIVED_AT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):/

/**
 * バックログ監視の閾値。KV の値は読まずキー一覧のみから判定するため、
 * どちらも「キー名から機械的に分かる情報」だけで計算できる。
 *
 * - EVENTSUB_PARK_BACKLOG_COUNT_THRESHOLD（件数、10件）:
 *   maintenance mode は本来まれにしか有効化されず、有効化される場合も
 *   短時間の cutover 作業が主目的（eventsub-park.ts の TTL 選定コメント参照）。
 *   10件は「一時的な数件のブレ」を許容しつつ「明らかに退避が溜まり続けている」
 *   状態を検知できる保守的な値として仮置きした。
 * - EVENTSUB_PARK_BACKLOG_AGE_MINUTES_THRESHOLD（経過時間、30分）:
 *   通常の cutover 作業は数時間〜長くて1日程度で完了する想定だが、
 *   30分はそれよりかなり短い値をあえて選んでいる。理由は「リプレイ忘れ・
 *   maintenance 解除忘れ」を早期検知したいため（偽陽性より見逃し防止を優先）。
 *
 * どちらも「issue #695 側に具体的な数値指定はないため仮の値」であり、
 * 実運用実績を見て Stage 7 の runbook 整備時に見直す前提（eventsub-park.ts
 * の TTL 選定コメントと同じ立て付け）。
 */
const EVENTSUB_PARK_BACKLOG_COUNT_THRESHOLD = 10
const EVENTSUB_PARK_BACKLOG_AGE_MINUTES_THRESHOLD = 30

/**
 * count===0 かつ list_complete=false（tombstone 追従、Major-1 対応）の場合に
 * 追加で辿る cursor ページ数の上限。
 *
 * 背景: Cloudflare Workers KV 公式ドキュメントによれば、最近失効・削除された
 * キー（tombstone）は list() の返す keys 配列には含まれないが、ページ内部では
 * 走査されるため、tombstone だけで1ページ（limit 件）が埋まることがある。
 * その結果「生キー0件（keys=[]）だが list_complete=false」という、素朴には
 * 「0件確定」に見えて実際には後続ページに生きたキーが存在しうる状態が起こる。
 * これを単純に count===0 として扱うと、実際には backlog が存在するのに
 * "No parked notifications" と誤報し監視が盲目化する（Fable レビュー Major-1）。
 *
 * 上限を設ける理由: tombstone が異常に連続した場合の無限ループ・レイテンシ膨張・
 * KV 課金増大を防ぐため。この監視の閾値はたった10件であり、正確な全件取得に
 * 際限なくコストを払う価値はない（YAGNI）。上限に達してもなお解決しない場合は
 * 安全側に倒し、「0件（backlogなし）」と断定せず unknown として扱う
 * （下記 getEventSubParkBacklogStats 参照）。
 */
const EVENTSUB_PARK_TOMBSTONE_FOLLOWUP_PAGE_LIMIT = 3

/**
 * Issue 本文の末尾に埋め込む識別用マーカー文字列。
 *
 * Major-2 対応より前は、これを GitHub Issue Search のクエリに含めて重複起票を
 * 防止していたが、現在は重複防止の判定に使っていない（下記
 * findOpenEventSubParkBacklogIssue のコメント参照）。人間が Issue 本文を見て
 * 「このワーカーが起票したものだ」と識別できるドキュメンテーション目的で
 * 残している。
 */
const EVENTSUB_PARK_BACKLOG_MARKER = 'Monitor: eventsub-park-backlog'

/**
 * backlog 監視専用の GitHub ラベル（Major-2 対応）。
 * findOpenEventSubParkBacklogIssue が Issues List API
 * （state=open&labels=...）で「このワーカーが起票した未対応の backlog Issue」を
 * 機械的に絞り込むために使う。誤マッチ防止（誰かが本文にマーカー文字列を
 * 引用しただけの無関係 Issue を拾わないこと）を、全文検索ではなくラベルという
 * メタデータで行う（support_inquiries 監視の label:support-inquiry と同じ方針）。
 */
const EVENTSUB_PARK_BACKLOG_LABEL = 'eventsub-park-backlog'

/** getEventSubParkBacklogStats の戻り値。 */
interface EventSubParkBacklogStats {
  /** 取得できたキー件数（1回の list 呼び出し内、上限 EVENTSUB_PARK_LIST_LIMIT）。 */
  count: number
  /**
   * count が実際の総件数と一致しない可能性がある場合 true。
   * limit に達して list_complete=false だった場合のみ true になる
   * （その場合でも limit 自体が閾値よりずっと大きいため、閾値判定には影響しない）。
   */
  countIsLowerBound: boolean
  /**
   * Major-1 対応: true の場合、count は信頼できない（"0件確定" とみなしてはならない）。
   * 生キー0件かつ list_complete=false のまま
   * EVENTSUB_PARK_TOMBSTONE_FOLLOWUP_PAGE_LIMIT 回の追加ページ取得でも解決しなかった
   * 状態（tombstone のみのページが連続している疑い）を示す。呼び出し元はこの場合
   * 「backlogなし」と扱わず、unknown であることを警告ログに残したうえで
   * この回の判定をスキップすること。
   */
  unknown: boolean
  /** 最古エントリの受信時刻（ISO8601）。パース可能なキーが1件もなければ null。 */
  oldestReceivedAt: string | null
  /** 最古エントリの経過時間（分、切り捨て）。oldestReceivedAt が null なら null。 */
  oldestAgeMinutes: number | null
}

/**
 * KV キー名から ISO8601 受信時刻を抽出する。プレフィックス不一致・
 * 時刻フォーマット不一致（想定外のキー）の場合は null を返し、防御的に
 * 呼び出し元でスキップさせる。
 */
export function parseParkedEventSubKeyReceivedAt(key: string): string | null {
  if (!key.startsWith(EVENTSUB_PARK_KEY_PREFIX)) return null
  const rest = key.slice(EVENTSUB_PARK_KEY_PREFIX.length)
  const match = rest.match(EVENTSUB_PARK_RECEIVED_AT_PATTERN)
  return match ? match[1] : null
}

/**
 * KV 一覧から backlog の件数・最古エントリの経過時間を算出する。
 *
 * 基本は1回の list 呼び出し（limit=1000、Workers KV の1リクエストあたり最大件数）で
 * 完結させる設計。全件を正確に数えるための無条件のページネーション（cursor を
 * 辿って全件取得）はあえて実装しない: 閾値が10件なので、1000件取得できた時点で
 * 既に閾値の100倍であり「超過している」という結論は変わらない。追加の list 呼び出し
 * （課金・レイテンシ）を無条件に払う価値がない（YAGNI）。
 *
 * 最古エントリの特定に全件ソートを行わない理由: KV の list は既定でキー名の
 * 辞書順（UTF-8バイト順）に返し、ISO8601 文字列は辞書順=時刻順になるため
 * （eventsub-park.ts の parkEventSubNotification コメント参照）、
 * 返却された keys 配列の先頭からパース可能な最初のキーが最古エントリになる。
 *
 * Major-1 対応（tombstone 追従）: 上記の「1000件取れたら閾値の100倍だから安全」
 * という判断は、返ってきた keys 配列が「実際に存在するキー」であることを前提に
 * している。しかし Cloudflare Workers KV は最近失効・削除されたキー
 * （tombstone）を keys 配列に含めない一方でページ内部の走査には数えるため、
 * tombstone だけで1ページ（limit 件）が埋まり「keys=[]（生キー0件）だが
 * list_complete=false」という状態になりうる。これを単純に count===0 として
 * 扱うと、実際には backlog が存在するのに誤って「0件」と報告してしまう。
 * そのため生キー0件かつ list_complete=false の場合のみ、
 * EVENTSUB_PARK_TOMBSTONE_FOLLOWUP_PAGE_LIMIT 回を上限に cursor で追加ページを
 * 辿り、生キーが見つかるか list_complete になるまで様子を見る。上限に達しても
 * まだ解決しない場合は count を信頼せず unknown=true を返す（呼び出し元は
 * これを「0件」と混同してはならない）。
 */
async function getEventSubParkBacklogStats(
  kv: EventSubParkKVNamespace,
  now: Date = new Date()
): Promise<EventSubParkBacklogStats> {
  const EVENTSUB_PARK_LIST_LIMIT = 1000
  let list = await kv.list({
    prefix: EVENTSUB_PARK_KEY_PREFIX,
    limit: EVENTSUB_PARK_LIST_LIMIT,
  })

  let followupPages = 0
  while (
    list.keys.length === 0 &&
    !list.list_complete &&
    followupPages < EVENTSUB_PARK_TOMBSTONE_FOLLOWUP_PAGE_LIMIT
  ) {
    followupPages++
    list = await kv.list({
      prefix: EVENTSUB_PARK_KEY_PREFIX,
      limit: EVENTSUB_PARK_LIST_LIMIT,
      cursor: list.cursor,
    })
  }

  // 追加ページを上限まで辿ってもなお「生キー0件かつ未完了」なら、tombstone の
  // 連続で解決しなかったとみなし、0件と断定せず unknown として呼び出し元に返す。
  const unknown = list.keys.length === 0 && !list.list_complete

  let oldestReceivedAt: string | null = null
  for (const { name: key } of list.keys) {
    const receivedAt = parseParkedEventSubKeyReceivedAt(key)
    if (receivedAt) {
      oldestReceivedAt = receivedAt
      break
    }
  }

  const oldestAgeMinutes =
    oldestReceivedAt !== null
      ? Math.floor((now.getTime() - new Date(oldestReceivedAt).getTime()) / 60000)
      : null

  return {
    count: list.keys.length,
    countIsLowerBound: !list.list_complete,
    unknown,
    oldestReceivedAt,
    oldestAgeMinutes,
  }
}

/**
 * 既存の Open Issue を専用ラベルで検索する（重複起票防止）。
 *
 * Major-2 対応の経緯: 当初は共通ヘルパ searchIssue（GitHub Search API）を
 * 再利用していた。しかし searchIssue は「検索インデックスは非同期更新であり
 * 作成直後の Issue はヒットしないことがある」ことを前提に、API 失敗時は
 * 例外を投げず null（＝Issue なし）を返す fail-open 設計になっている。
 * errors/support_inquiries 監視ではこの fail-open は許容できる
 * ——「処理済みフラグ」という別の冪等性の本命があるため、search は
 * あくまで補助（findExistingErrorIssue / processInquiries 内のコメント参照）。
 * だが、この backlog 監視には処理済みフラグに相当するものが存在せず、
 * search 結果だけが唯一の重複防止ガードだった。GitHub Search API の障害・
 * レート制限・インデックス反映遅延（5分を超えることがある）のいずれでも、
 * 5分ごとの cron で上限なく重複 Issue が作成されうる（最悪 288 件/日）。
 *
 * 対応（案(b)を優先し、案(a)のfail-closedも併用）:
 * 1. GitHub Search API ではなく Issues List API
 *    （GET /repos/{owner}/{repo}/issues?labels=...&state=open）を使う。
 *    こちらはコアのレート制限（Search の 30 req/min よりずっと高い）に乗り、
 *    検索インデックスの非同期反映に依存しない（作成直後の Issue も確実に
 *    拾える）。`state=open` を明示的に指定する理由は元の `is:open` と同じ:
 *    運用者が Issue をクローズした後に backlog が再発した場合、クローズ済みの
 *    古い Issue に引っかかって再起票がブロックされ続けると再発を見逃すため。
 * 2. 誤マッチ防止は本文中のマーカー文字列ではなく専用ラベル
 *    （EVENTSUB_PARK_BACKLOG_LABEL）で行う。ラベルはメタデータであり、
 *    誰かが Issue 本文でマーカー文字列を偶然/意図的に引用しただけの無関係
 *    Issue を拾う余地がない。
 * 3. それでも API 呼び出し自体が失敗した場合（ネットワーク断・GitHub 障害・
 *    トークン権限不足等）は fail-closed にする（例外を投げ、呼び出し元
 *    processEventSubParkBacklog で Issue 作成をスキップさせる）。
 *    処理済みフラグという保険が無いため、ここは errors/support_inquiries の
 *    fail-open 方針をそのまま踏襲しない —— 「重複を作るくらいなら今回は
 *    起票を諦めて次の cron tick に賭ける」を選ぶ。
 */
async function findOpenEventSubParkBacklogIssue(
  env: Env
): Promise<{ number: number; url: string } | null> {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}/issues?labels=${encodeURIComponent(EVENTSUB_PARK_BACKLOG_LABEL)}&state=open&per_page=1`
  const res = await fetch(url, { headers: githubHeaders(env) })

  if (!res.ok) {
    const text = await res.text()
    // fail-closed: 例外を投げて呼び出し元に伝播させる（新規 Issue 作成させない）。
    throw new Error(`GitHub Issues List API error: ${res.status} ${text}`)
  }

  const issues = (await res.json()) as Array<{ number: number; html_url: string }>
  if (issues.length > 0) {
    return { number: issues[0].number, url: issues[0].html_url }
  }
  return null
}

/** GitHub Issue のペイロードを組み立てる（EventSub 退避 backlog 監視用）。 */
function buildEventSubParkBacklogIssue(
  stats: EventSubParkBacklogStats
): { title: string; body: string; labels: string[] } {
  const countLabel = `${stats.count}${stats.countIsLowerBound ? '+' : ''}`
  const title = `[EventSub Park Backlog] 退避データが ${countLabel} 件滞留中`.slice(0, 80)

  const body = `## EventSub 退避 backlog 監視アラート

maintenance mode 中に KV へ退避された EventSub notification
（\`maintenance:eventsub:*\`）が、以下の閾値を超えて滞留しています。

**件数**: ${countLabel} 件（閾値: ${EVENTSUB_PARK_BACKLOG_COUNT_THRESHOLD} 件以上）
**最古エントリ受信時刻**: ${stats.oldestReceivedAt ?? '不明'}
**最古エントリ経過時間**: ${stats.oldestAgeMinutes !== null ? `${stats.oldestAgeMinutes} 分` : '不明'}（閾値: ${EVENTSUB_PARK_BACKLOG_AGE_MINUTES_THRESHOLD} 分以上）

### 想定される原因
- maintenance mode が意図せず有効なまま長時間放置されている
- maintenance mode は解除済みだが、退避データのリプレイが未実施
  （\`npm run replay:maintenance-eventsub -- --url=<base-url>\`、
  詳細は docs/db-phase2-runbook.md を参照）

### 対応後
このアラートには自動クローズが無いため、対応後は手動でこの Issue を
クローズしてください。backlog が解消しないまま次回 cron 実行（5分後）を
迎えても、この Issue が Open のままなら再起票はされません
（Open Issue が既にある間はスキップする設計、実装コメント参照）。

---
${EVENTSUB_PARK_BACKLOG_MARKER}
*Auto-generated by [twica-error-reporter](https://github.com/azumag/twica/issues/695)*`

  // EVENTSUB_PARK_BACKLOG_LABEL は必須: findOpenEventSubParkBacklogIssue が
  // Issues List API でこのラベルを絞り込み条件に使うため、ここで付け忘れると
  // 次回以降の重複起票防止が機能しなくなる。
  return { title, body, labels: ['bug', 'auto-generated', 'maintenance', EVENTSUB_PARK_BACKLOG_LABEL] }
}

/**
 * EventSub 退避 backlog 監視本体。
 * 1. RATE_LIMIT_KV からキー一覧を取得し、件数・最古エントリの経過時間を算出
 *    （kv.get は呼ばない。値ではなくキー名だけで判定できるため）
 * 2. どちらかの閾値を超えていなければ何もしない
 * 3. 超えていれば、既存の Open Issue を検索 → あればスキップ（再起票しない）、
 *    なければ新規作成
 *
 * 「既存 Open Issue があれば更新（コメント追加）」ではなく「スキップ」を選んだ
 * 理由: この監視は5分ごとに毎回同じ判定をやり直すだけで、errors 処理のような
 * 「新規発生イベント」の単位を持たない。Open のままコメントを追加し続けると、
 * backlog が解消しない間（例: maintenance mode が長時間続く運用上正常なケース）
 * 5分に1回コメントが増え続けるスパムになる。Issue が Open であること自体が
 * 「まだ未対応」を示す十分な情報であるため、追加コメントは付加価値が薄い。
 */
export async function processEventSubParkBacklog(env: Env): Promise<void> {
  console.log('[EventSub Park Monitor] Started')

  if (!env.RATE_LIMIT_KV) {
    console.error('[EventSub Park Monitor] Missing RATE_LIMIT_KV binding in wrangler.toml')
    return
  }

  const stats = await getEventSubParkBacklogStats(env.RATE_LIMIT_KV)

  // Major-1 対応: tombstone 追従でも解決しなかった「本当に0件か不明」な状態。
  // 0件と断定して沈黙するとバックログを見逃すリスクがあるため、warn で明示的に
  // 検知可能にしたうえで、信頼できない数値で誤って Issue を起票しないよう
  // この回の判定はスキップする（次回 cron 実行で再評価される）。
  if (stats.unknown) {
    console.warn(
      '[EventSub Park Monitor] Unable to determine backlog state: KV list returned 0 raw keys but list_complete=false after tombstone followup pages. Skipping this run (will retry next cron tick).'
    )
    return
  }

  if (stats.count === 0) {
    console.log('[EventSub Park Monitor] No parked notifications')
    return
  }

  const overThreshold =
    stats.count >= EVENTSUB_PARK_BACKLOG_COUNT_THRESHOLD ||
    (stats.oldestAgeMinutes !== null &&
      stats.oldestAgeMinutes >= EVENTSUB_PARK_BACKLOG_AGE_MINUTES_THRESHOLD)

  if (!overThreshold) {
    console.log(
      `[EventSub Park Monitor] Below threshold (count=${stats.count}, oldestAgeMinutes=${stats.oldestAgeMinutes})`
    )
    return
  }

  console.warn(
    `[EventSub Park Monitor] Backlog threshold exceeded (count=${stats.count}, oldestAgeMinutes=${stats.oldestAgeMinutes})`
  )

  const existing = await findOpenEventSubParkBacklogIssue(env)
  if (existing) {
    console.log(`[EventSub Park Monitor] Open issue #${existing.number} already exists, skipping`)
    return
  }

  const issue = await postGitHubIssue(env, buildEventSubParkBacklogIssue(stats))
  console.log(`[EventSub Park Monitor] Created issue #${issue.number}: ${issue.url}`)
}

// =============================================================================
// Cron Trigger エントリポイント
// =============================================================================

export default {
  /**
   * Cron Trigger ハンドラ: 5分ごとに実行される。
   * 環境変数を検証したうえで、エラー処理と問い合わせ処理を順に実行する。
   * 2つの処理は独立しており、片方が失敗しても他方は実行される。
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    // 環境変数バリデーション（両処理共通）: 未設定の場合は早期リターン。
    // secret 未設定でも無害に空振りする。
    if (!env.SUPABASE_URL || !getSupabaseApiKey(env) || !env.GITHUB_TOKEN) {
      console.error('[Reporter] Missing required secrets. Set SUPABASE_URL, SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY), GITHUB_TOKEN via wrangler secret put')
      return
    }
    if (!env.GITHUB_REPO_OWNER || !env.GITHUB_REPO_NAME) {
      console.error('[Reporter] Missing GITHUB_REPO_OWNER or GITHUB_REPO_NAME in wrangler.toml [vars]')
      return
    }

    // エラー処理と問い合わせ処理は独立。片方の失敗が他方を止めないよう個別に捕捉。
    try {
      await processErrors(env)
    } catch (err) {
      console.error('[Error Reporter] Cron job failed:', err)
    }

    try {
      await processInquiries(env)
    } catch (err) {
      console.error('[Inquiry Reporter] Cron job failed:', err)
    }

    try {
      await processEventSubParkBacklog(env)
    } catch (err) {
      console.error('[EventSub Park Monitor] Cron job failed:', err)
    }
  },
}
