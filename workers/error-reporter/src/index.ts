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
  },
}
