#!/usr/bin/env node

/**
 * provider-neutral migration runner CLI / Issue #692
 *
 * 背景:
 * 現行の migration 適用は `npm run db:push`（`supabase db push`）に一本化されており、
 * Supabase CLI の migration 履歴・実行semanticsに暗黙に依存している。PlanetScale切替後は
 * この経路が使えなくなるため、通常の PostgreSQL connection string（`postgres` パッケージ、
 * scripts/verify-db-schema.js と同じ依存）だけで動く独立の migration runner を用意する。
 *
 * 設計の要点（詳細は scripts/lib/db-migrate-core.js のコメント・Issue #692 参照）:
 *   - 履歴は `twica_meta.schema_migrations`（Supabase管理schemaを正本にしない）
 *   - 同時実行防止は PostgreSQL advisory lock（`pg_advisory_lock(hashtext(...))`）
 *   - migration 成功と履歴insertは同一トランザクションでcommit
 *     （`transaction: forbidden` 宣言のファイルのみ、SQL実行成功後に非トランザクションで別途記録。
 *     PostgreSQLは複数文のsimple queryバッチを暗黙のトランザクションブロックとして実行するため、
 *     forbidden ファイルは実質的に「SQL文1つのみ」をサポートする。2文以上あれば
 *     descriptorの組み立て時点（buildMigrationDescriptor）でエラーとして検知する）
 *   - 適用済みversionのchecksum変更は status/plan/apply/verify いずれも即座にエラー終了
 *   - `--bootstrap` は既存ファイルを「実行せず」history にだけ登録する
 *     （実DBが既にこの内容を反映済みという前提。実行タスクは Issue #692 のスコープ外）
 *   - history table が存在しない（＝一度もapply/bootstrapされていない）DBに対して
 *     `--bootstrap` 無しで大量のmigrationをapplyしようとした場合、誤操作防止のため
 *     `--confirm-fresh-apply` を要求する（Fableレビュー Medium-1）
 *
 * 使い方:
 *   DATABASE_URL="postgres://..." node scripts/db-migrate.js status
 *   DATABASE_URL="postgres://..." node scripts/db-migrate.js plan
 *   DATABASE_URL="postgres://..." node scripts/db-migrate.js apply
 *   DATABASE_URL="postgres://..." node scripts/db-migrate.js apply --bootstrap
 *   DATABASE_URL="postgres://..." node scripts/db-migrate.js verify
 *   DATABASE_URL="postgres://..." node scripts/db-migrate.js status --provider=planetscale
 *   npm run db:migrate:status / db:migrate:plan / db:migrate:apply / db:migrate:verify
 *
 * 接続文字列について:
 * scripts/replay-maintenance-eventsub.js と同じ方針で、DATABASE_URL は環境変数からのみ読む
 * （CLI引数にしない。シェル履歴・`ps aux` 等への漏洩を避けるため）。
 * ログ・エラーメッセージには常に redact 済みの接続文字列のみを出力する
 * （scripts/lib/db-migrate-core.js の redactConnectionString / redactSecretsFromText 参照）。
 *
 * 終了コード（scripts/verify-db-schema.js と同じ規約）:
 *   0 = 成功（statusは「未適用migrationがある」だけでは非ゼロにしない）
 *   1 = 検証エラー（version重複・descriptor不正・checksum不一致・SQL実行失敗など）
 *   2 = 接続失敗等の運用エラー（想定外の例外）
 */

'use strict'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('crypto')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./lib/db-migrate-core')

const SUPABASE_MIGRATIONS_DIR = path.join(__dirname, '..', 'supabase', 'migrations')

// PlanetScale専用migration用ディレクトリ（Issue #691 Chunk 1 C-1対応、Fableレビュー）。
// `supabase/migrations/` には置かない: `.github/workflows/deploy-cloudflare.yml` の
// `supabase db push --db-url "$SUPABASE_DB_URL" --yes` は `supabase/migrations/` 配下の
// 未適用ファイルをSupabase CLIの判断で全て適用してしまい、本プロジェクト独自の
// `-- migration-providers: planetscale` ヘッダーコメントを解釈しない（ただのSQLコメントとして
// 無視される）ため、PlanetScale専用ファイルが実Supabase preview/prodへ誤適用される
// リスクがある。Supabase CLIが一切スキャンしないこのディレクトリに分離することで、
// 誤適用経路そのものを構造的に無くす（`migration-providers` ヘッダーによるprovider絞り込みは
// 引き続き維持し、多重防御とする）。
const PLANETSCALE_MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'planetscale', 'migrations')

/**
 * provider に応じて読み込む migration ディレクトリの配列を解決する純粋関数
 * （Issue #691 Chunk 1 C-1対応）。
 * `planetscale` のみ、共通/Supabase向け migration（`supabase/migrations/`）に加えて
 * PlanetScale専用ディレクトリ（`db/planetscale/migrations/`）も対象にする。
 * `supabase`/`postgres` は従来通り `supabase/migrations/` のみを見る
 * （`db/planetscale/migrations/` の存在自体を意識しない）。
 *
 * @param {string} provider
 * @returns {string[]}
 */
function resolveMigrationsDirs(provider) {
  if (provider === 'planetscale') {
    return [SUPABASE_MIGRATIONS_DIR, PLANETSCALE_MIGRATIONS_DIR]
  }
  return [SUPABASE_MIGRATIONS_DIR]
}

const HELP_TEXT = `
使い方:
  DATABASE_URL="postgres://..." node scripts/db-migrate.js <command> [options]
  npm run db:migrate:status / db:migrate:plan / db:migrate:apply / db:migrate:verify

コマンド:
  status    未適用・適用済み・checksum不一致を一覧表示する（read-only）
  plan      apply が何をするかを dry-run 表示する（read-only、DB書き込みなし）
  apply     未適用migrationを順に適用する（advisory lock・transaction制御込み）
  verify    history とディスク上のファイルの整合性のみを検証する（read-only、CI向け）

オプション:
  --provider=<supabase|planetscale|postgres>
            対象provider（省略時 supabase。PlanetScale切替（#691）後にこのデフォルトは
            見直しが必要になる可能性がある）。migration descriptor の migration-providers
            宣言に基づき、対象外のmigrationは適用/表示から除外される。
            必ず "=" で値を指定すること（例: --provider=planetscale）。
            "--provider planetscale" のようにスペース区切りにすると不明な引数として
            エラーになる。
            planetscale指定時のみ、supabase/migrations/ に加えて
            db/planetscale/migrations/（PlanetScale専用、supabase db push が
            スキャンしない別ディレクトリ）もファイル名昇順でマージして読み込む
            （resolveMigrationsDirs参照）。
  --bootstrap
            apply コマンド専用。未登録の全migrationファイルを「SQLを実行せずに」
            history へ登録する（実DBが既にこの内容を反映済みという前提のbootstrapモード）。
  --confirm-fresh-apply
            apply コマンド専用。history table がまだ存在しない（一度もapply/bootstrapが
            実行されていない）DBに対し、--bootstrap を付けずに一定件数以上のmigrationを
            通常applyしようとした場合の確認フラグ。本番DBのような「実際には適用済みのはず」の
            DBへ --bootstrap を付け忘れて誤って全SQLを実行してしまう事故を防ぐためのガード。
  --help, -h
            このヘルプを表示する

制約:
  migration-transaction: forbidden を宣言したファイルは、SQL文を1つだけ含む必要がある
  （PostgreSQLは複数文のsimple queryバッチを暗黙のトランザクションブロックとして実行するため、
  CREATE INDEX CONCURRENTLY 等を2本以上まとめて forbidden ファイルに書くと実行時エラーになる。
  これは descriptor 読み込み時点で検知され、status/plan/apply/verify いずれも即座にエラー終了する）。

接続文字列:
  DATABASE_URL は環境変数からのみ読み込む（CLI引数では指定できない。シェル履歴・
  プロセス一覧への漏洩を避けるため）。ログには常にパスワードをマスクした形式で出力する。
`.trim()

// parseArgs が認識する真偽値フラグ（値を取らないもの）。
// これに含まれず `--` で始まる引数は「未知のフラグ」として unknownArgs に積まれる
// （Issue #692 Fableレビュー High-2: 未知フラグ・typoを黙って無視しない）。
const KNOWN_BOOLEAN_FLAGS = ['--help', '-h', '--bootstrap', '--confirm-fresh-apply']

// 未知フラグに対する簡易な「もしかして」候補（--help との組み合わせは対象外）。
// 厳密な曖昧一致ライブラリは導入せず、Levenshtein距離が近いものだけを提案する簡易実装
// （YAGNI: このCLIのフラグ数は少なく、厳密なfuzzy matchingを導入する価値が薄いため）。
const SUGGESTABLE_FLAGS = ['--help', '--bootstrap', '--confirm-fresh-apply']

/** 2文字列間の編集距離（Levenshtein距離）を計算する純粋関数 */
function levenshteinDistance(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0))
  for (let i = 0; i < rows; i++) dp[i][0] = i
  for (let j = 0; j < cols; j++) dp[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[rows - 1][cols - 1]
}

/**
 * 未知フラグに対する「もしかして」候補を返す純粋関数。既知の候補と距離2以内なら提案する。
 * `--provider` は特別扱い（`=値` の付け忘れという典型的なミスを個別に案内する）。
 * @param {string} unknownArg
 * @returns {string | undefined}
 */
function suggestFlag(unknownArg) {
  if (unknownArg === '--provider') {
    return '--provider=<値> ("=" が必要です。例: --provider=planetscale)'
  }
  let best
  let bestDistance = Infinity
  for (const known of SUGGESTABLE_FLAGS) {
    const distance = levenshteinDistance(unknownArg, known)
    if (distance < bestDistance) {
      bestDistance = distance
      best = known
    }
  }
  return bestDistance <= 2 ? best : undefined
}

/**
 * process.argv から CLI オプションを取り出す純粋関数。
 * 未知のフラグ（`--` で始まるが KNOWN_BOOLEAN_FLAGS にも `--provider=` にも一致しないもの）と、
 * コマンド以外の2個目以降の位置引数は unknownArgs に集約する（黙って無視しない。
 * Issue #692 Fableレビュー High-2 実測事故: `apply --boostrap`（typo）が黙ってapplyされる、
 * `status --provider planetscale`（スペース区切り）が黙って provider=supabase のまま実行される、
 * `status garbage-arg` が黙殺される、の3件）。
 */
function parseArgs(argv) {
  const args = argv.slice(2)
  const help = args.includes('--help') || args.includes('-h')
  const bootstrap = args.includes('--bootstrap')
  const confirmFreshApply = args.includes('--confirm-fresh-apply')

  let command
  let providerFlag
  const unknownArgs = []
  for (const arg of args) {
    if (KNOWN_BOOLEAN_FLAGS.includes(arg)) continue
    if (arg.startsWith('--provider=')) {
      providerFlag = arg
      continue
    }
    if (arg.startsWith('--')) {
      unknownArgs.push(arg)
      continue
    }
    if (command === undefined) {
      command = arg
    } else {
      // 2個目以降の '--' で始まらない引数 = 余剰位置引数（例: `status garbage-arg`）
      unknownArgs.push(arg)
    }
  }

  const provider = providerFlag ? providerFlag.slice('--provider='.length) : undefined
  return { help, command, bootstrap, confirmFreshApply, provider, unknownArgs }
}

const VALID_COMMANDS = ['status', 'plan', 'apply', 'verify']

/**
 * CLI引数・環境変数から実行設定を解決する純粋関数。
 * scripts/replay-maintenance-eventsub.js の resolveConfig と同じ流儀
 * （help / error / 正常系の3値を返す）。
 */
function resolveConfig(argv, env) {
  const { help, command, bootstrap, confirmFreshApply, provider, unknownArgs } = parseArgs(argv)
  if (help) return { help: true }

  if (unknownArgs.length > 0) {
    const details = unknownArgs
      .map((a) => {
        const suggestion = suggestFlag(a)
        return suggestion ? `${a}（もしかして ${suggestion} ですか？）` : a
      })
      .join(', ')
    return { error: `不明な引数です: ${details}` }
  }

  if (!command || !VALID_COMMANDS.includes(command)) {
    return { error: `コマンドは ${VALID_COMMANDS.join('/')} のいずれかを指定してください。--help を参照してください。` }
  }

  if (bootstrap && command !== 'apply') {
    return { error: '--bootstrap は apply コマンドでのみ使用できます。' }
  }

  if (confirmFreshApply && command !== 'apply') {
    return { error: '--confirm-fresh-apply は apply コマンドでのみ使用できます。' }
  }

  // 「--provider=」（フラグは指定されているが値が空文字列）を、フラグ自体の省略と同じ
  // supabaseフォールバックへ黙って倒さない（Issue #692 Fableレビュー 最終回・軽微指摘）。
  // parseArgs は `--provider=` を providerFlag ありと判定し provider に空文字列を返す一方、
  // フラグ自体が省略された場合は provider が undefined になる（この2つは区別できる）。
  // CI等でシェル変数展開が空になった場合に黙って意図しないproviderへフォールバックする事故を
  // 防ぐため、値が空文字列の場合のみ明示的にエラーとする（High-2の --boostrap typo対応と同じ思想）。
  if (provider === '') {
    return { error: '--provider に値が指定されていません（例: --provider=planetscale）。' }
  }

  // --provider のデフォルトは 'supabase' 固定（Issue #692 Fableレビュー Medium-3）。
  // PlanetScale切替（#691）着手時、実運用のデフォルトprovider方針が変わる可能性があるため
  // このデフォルト値自体を見直す必要が出てくるかもしれない。
  const resolvedProvider = provider || 'supabase'
  if (!core.VALID_PROVIDERS.includes(resolvedProvider)) {
    return {
      error: `--provider には ${core.VALID_PROVIDERS.join('/')} のいずれかを指定してください: ${resolvedProvider}`,
    }
  }

  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl || !databaseUrl.trim()) {
    return {
      error: '環境変数 DATABASE_URL が設定されていません。接続文字列は環境変数でのみ受け付けます（CLI引数不可）。',
    }
  }

  return { command, bootstrap, confirmFreshApply, provider: resolvedProvider, databaseUrl }
}

/**
 * MIGRATION_APPLIED_BY 環境変数、無ければ OS ユーザー名を「誰が適用したか」として使う。
 * サンドボックス等で userInfo() が失敗する環境向けに 'unknown' へフォールバックする。
 */
function resolveAppliedBy(env) {
  if (env.MIGRATION_APPLIED_BY && env.MIGRATION_APPLIED_BY.trim()) {
    return env.MIGRATION_APPLIED_BY.trim()
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('os').userInfo().username
  } catch {
    return 'unknown'
  }
}

/**
 * postgres.js クライアントを生成する（DB接続あり、単体テスト対象外）。
 * max:1 で単一コネクションに固定するのは、advisory lock がセッションスコープのため
 * （lock取得・migration実行・lock解放が同じコネクションで行われる必要がある）。
 * onnotice で収集した warning は warningSink.list に積む。warningSink.current を
 * 呼び出し側が実行中のmigration versionに書き換えることで、どのmigration実行中に
 * 発生したwarningかを紐付ける（Issue #692 要件: warningを黙って握りつぶさない）。
 */
function createSqlClient(databaseUrl, warningSink) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const postgres = require('postgres')
  // PlanetScale接続文字列が付与する sslrootcert パラメータは postgres.js が
  // 未知の接続オプションとしてサーバーへ送りつけてしまい接続失敗する
  // （core.stripPostgresJsIncompatibleSslParams のdocコメント参照。実機確認済み）。
  return postgres(core.stripPostgresJsIncompatibleSslParams(databaseUrl), {
    max: 1,
    connect_timeout: 15,
    onnotice: (notice) => {
      warningSink.list.push({
        migration: warningSink.current,
        severity: notice.severity,
        message: notice.message,
      })
    },
  })
}

/** twica_meta.schema_migrations が存在するかを、例外を投げずに確認する */
async function historyTableExists(sql) {
  const rows = await sql`select to_regclass('twica_meta.schema_migrations') as reg`
  return rows[0].reg !== null
}

/** history テーブルから全行を読む。テーブルが無ければ { exists: false, rows: [] } を返す */
async function fetchHistoryRows(sql) {
  const exists = await historyTableExists(sql)
  if (!exists) return { exists: false, rows: [] }
  const rows = await sql`
    select version, name, checksum, applied_at, applied_by, execution_id
    from twica_meta.schema_migrations
    order by version
  `
  return { exists: true, rows }
}

/**
 * ディスク上のmigration一覧とDB historyを突き合わせた状態を組み立てる。
 * status/plan/apply/verify の4コマンド全てがこの同一ロジックを共有することで、
 * 「checksum不一致等の整合性エラーはどのコマンドでも即座にエラー終了する」という
 * Issue #692 の要件を、個々のコマンドで重複実装せずに満たす。
 */
async function computeState(sql, migrationsDirs, provider) {
  const descriptors = core.loadMigrationFilesFromDirs(migrationsDirs)
  const duplicateVersions = core.findDuplicateVersions(descriptors)
  const descriptorErrors = core.collectDescriptorErrors(descriptors)
  const { exists, rows: historyRows } = await fetchHistoryRows(sql)
  const diff = core.diffMigrationState(descriptors, historyRows, provider)
  return { descriptors, duplicateVersions, descriptorErrors, historyTableExists: exists, historyRows, ...diff }
}

function hasBlockingErrors(state) {
  return (
    state.duplicateVersions.length > 0 ||
    state.descriptorErrors.length > 0 ||
    state.checksumMismatches.length > 0 ||
    state.missingFiles.length > 0
  )
}

// history table不存在（＝一度もapply/bootstrapが実行されていない）状態から、通常applyで
// 一気に適用してよいと判断する pending 件数の上限。既存71ファイル運用を踏まえ、
// 「本来は空のはずの真っ新DBへの初回セットアップ」と「本番Supabaseのような、実際には
// 全て適用済みのはずのDBへ --bootstrap を付け忘れた事故」を区別するための閾値
// （Issue #692 Fableレビュー Medium-1）。小規模な初期構築ならこの件数を超えないことが多い想定。
const FRESH_APPLY_PENDING_THRESHOLD = 5

/**
 * 「真っ新なDB（history table不存在）への誤った通常apply」をブロックすべきかどうかを判定する
 * 純粋関数（Issue #692 Fableレビュー Medium-1）。
 *
 * 実測で確認された事故: history テーブルが存在しない状態で `--bootstrap` を付け忘れて
 * 通常の `apply` を実行すると、71件のmigrationファイルが実際に（意図せず）SQL実行されてしまう。
 * 本番Supabase DBのような「実際には全て適用済みのはずのDB」に対してこれをやると事故になりうる。
 *
 * `--bootstrap` 指定時・pending件数が閾値未満・history table が既に存在する場合はブロック不要。
 * それ以外（真っ新DB + 大量pending + bootstrap無し）は、`--confirm-fresh-apply` が
 * 明示されていない限りブロックする。
 *
 * @param {{ bootstrap: boolean, historyTableExistedBefore: boolean, pendingCount: number, confirmFreshApply: boolean }} args
 * @returns {boolean} true ならブロック（apply を実行させない）
 */
function shouldBlockFreshApply({ bootstrap, historyTableExistedBefore, pendingCount, confirmFreshApply }) {
  if (bootstrap) return false
  if (historyTableExistedBefore) return false
  if (pendingCount < FRESH_APPLY_PENDING_THRESHOLD) return false
  return !confirmFreshApply
}

function printBlockingErrors(state) {
  console.error('[db-migrate] migration の整合性チェックに失敗しました:')
  for (const dup of state.duplicateVersions) {
    console.error(`  - version重複: ${dup.version} (${dup.filenames.join(', ')})`)
  }
  for (const e of state.descriptorErrors) {
    for (const msg of e.errors) {
      console.error(`  - ${e.filename}: ${msg}`)
    }
  }
  for (const m of state.checksumMismatches) {
    console.error(
      `  - checksum不一致（適用後にファイルが改変された可能性）: version=${m.version} name=${m.name} ` +
        `disk=${m.diskChecksum.slice(0, 12)}... history=${m.historyChecksum.slice(0, 12)}...`
    )
  }
  for (const m of state.missingFiles) {
    console.error(`  - 適用済みのはずのファイルがディスク上に見つかりません: version=${m.version} name=${m.name}`)
  }
}

async function cmdStatus(sql, migrationsDirs, provider) {
  const state = await computeState(sql, migrationsDirs, provider)
  if (hasBlockingErrors(state)) {
    printBlockingErrors(state)
    return 1
  }

  if (!state.historyTableExists) {
    console.log('[db-migrate] 履歴テーブル twica_meta.schema_migrations がまだ存在しません（apply未実行）。')
  }
  console.log(`[db-migrate] provider=${provider}`)
  console.log(`[db-migrate] 適用済み: ${state.applied.length}件`)
  for (const a of state.applied) {
    console.log(`  [applied] ${a.version} ${a.name} (applied_at=${a.appliedAt} applied_by=${a.appliedBy ?? '-'})`)
  }
  console.log(`[db-migrate] 未適用: ${state.pending.length}件`)
  for (const p of state.pending) {
    console.log(`  [pending] ${p.version} ${p.name} (transaction=${p.transaction})`)
  }
  if (state.skippedForProvider.length > 0) {
    console.log(`[db-migrate] provider不一致でスキップ: ${state.skippedForProvider.length}件`)
    for (const s of state.skippedForProvider) {
      console.log(`  [skip] ${s.version} ${s.name} (providers=${s.providers.join(',')})`)
    }
  }
  return 0
}

async function cmdPlan(sql, migrationsDirs, provider) {
  const state = await computeState(sql, migrationsDirs, provider)
  if (hasBlockingErrors(state)) {
    printBlockingErrors(state)
    return 1
  }

  console.log(`[db-migrate] plan (dry-run、DB書き込みなし) provider=${provider}`)
  if (state.pending.length === 0) {
    console.log('  適用対象の未適用migrationはありません（apply実行時もno-opになります）')
  } else {
    console.log(`  以下 ${state.pending.length} 件が apply 実行時にファイル名昇順で適用されます:`)
    for (const p of state.pending) {
      console.log(`    ${p.version} ${p.name} (transaction=${p.transaction})`)
    }
  }
  if (state.skippedForProvider.length > 0) {
    console.log(`  provider不一致でスキップされる: ${state.skippedForProvider.length}件`)
    for (const s of state.skippedForProvider) {
      console.log(`    ${s.version} ${s.name} (providers=${s.providers.join(',')})`)
    }
  }
  return 0
}

function printApplySummary(results, warnings) {
  console.log('')
  console.log('[db-migrate] apply サマリ:')
  const counts = {}
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
  console.log(`  結果: ${JSON.stringify(counts)} (対象 ${results.length}件)`)
  if (warnings.length > 0) {
    console.log(`  PostgreSQL warning: ${warnings.length}件（黙って握りつぶさず全件表示する）`)
    for (const w of warnings) {
      console.log(`    [${w.severity}] (migration=${w.migration ?? 'setup'}) ${w.message}`)
    }
  } else {
    console.log('  PostgreSQL warning: なし')
  }
}

/**
 * apply コマンド本体。advisory lock を取得したセッション内で、
 * history テーブルの存在確認・整合性チェック・実際の適用（またはbootstrap登録）を行う。
 */
async function cmdApply(sql, migrationsDirs, provider, { bootstrap, confirmFreshApply, appliedBy, warningSink }) {
  // 同時実行防止: 固定キーの advisory lock を取得する。既に別プロセスが保持している場合は
  // ここでブロックし、解放され次第このプロセスが取得する（Issue #692: 「待機またはエラー」の
  // うち「待機」を採用。取得後は他方が適用済みの内容を読むだけなので自然にno-opになる）。
  await sql`select pg_advisory_lock(hashtext(${core.ADVISORY_LOCK_KEY_INPUT}))`
  try {
    // schema/table 作成の「前」に存在有無を記録しておく（Medium-1のfresh applyガード判定に使う）。
    const historyTableExistedBefore = await historyTableExists(sql)

    // computeState は fetchHistoryRows 経由で historyTableExists を再度呼ぶが、schema/table を
    // 作成する「前」に呼んでも to_regclass ベースのため例外にならず、テーブル不存在時は
    // { exists: false, rows: [] } を返す（＝全migrationがpending扱いになる）。つまり
    // shouldBlockFreshApply の判定に必要な pending 件数は、schema/table 作成前でも正しく計算できる。
    //
    // 重要（Fableレビュー最終回・重大バグ修正）: schema/table の作成は、必ずこのガード判定の
    // 「後」（かつ実際に history insert が必要になる直前）まで遅らせること。以前の実装では
    // ガード判定の前に IF NOT EXISTS でテーブルを作成していたため、1回目の実行はブロックされる
    // （exit 1）ものの、その時点で空の twica_meta.schema_migrations が実際に作成されてしまい、
    // 同じコマンドを2回目に実行すると historyTableExistedBefore が true になってガードが
    // 発動せず、全pending migrationが実行されてしまう事故があった（Docker実機で再現済み）。
    // ガードがブロックする経路では schema/table を一切作成しないことで、この「1回しか効かない」
    // 問題を防ぐ。
    const state = await computeState(sql, migrationsDirs, provider)
    if (hasBlockingErrors(state)) {
      printBlockingErrors(state)
      return 1
    }

    // Medium-1: 真っ新なDB（history table不存在）への誤った通常applyガード。
    // --bootstrap の付け忘れで本番相当DBに大量のSQLを実際に実行してしまう事故を防ぐ。
    if (
      shouldBlockFreshApply({
        bootstrap,
        historyTableExistedBefore,
        pendingCount: state.pending.length,
        confirmFreshApply,
      })
    ) {
      console.error(
        `[db-migrate] 警告: history テーブルが存在しません（一度も apply/bootstrap が実行されていません）。` +
          `この状態で --bootstrap 無しの通常 apply を実行すると、未適用として検知された ` +
          `${state.pending.length} 件のmigrationファイルが実際に（意図せず）SQL実行されます。`
      )
      console.error(
        '[db-migrate] 本番相当のDBに対して --bootstrap を付け忘れている可能性があります。' +
          '意図した操作であれば --confirm-fresh-apply を付けて再実行してください。' +
          '実DBが既にこの内容を反映済みなら、代わりに apply --bootstrap を検討してください。'
      )
      // ここで return する時点では schema/table を一切作成していない
      // （＝再実行してもガードは変わらず機能し続ける）。
      return 1
    }

    // ガードを通過した（＝実際に history へ書き込みが発生し得る）場合にのみ、schema/table を
    // IF NOT EXISTS で作成する（advisory lock 配下のため複数プロセスが同時にここへ来ることはない）。
    // 「既に存在する」場合は毎回 IF NOT EXISTS が Postgres NOTICE ("already exists, skipping") を
    // 発生させてしまい、apply結果サマリのwarning欄が初回適用後の全ての通常実行で意味の無い
    // ノイズで埋まる。事前に存在確認し、無い場合だけ作成することで、本当に意味のあるwarning
    // （migration本体からのもの）だけがサマリに残るようにする。
    if (!historyTableExistedBefore) {
      await sql.unsafe(core.HISTORY_SCHEMA_SQL)
      await sql.unsafe(core.HISTORY_TABLE_SQL)
    }

    if (!bootstrap && !historyTableExistedBefore && confirmFreshApply && state.pending.length >= FRESH_APPLY_PENDING_THRESHOLD) {
      // shouldBlockFreshApply が false を返したのが --confirm-fresh-apply によるものである場合のみ
      // 表示する（--bootstrap 経由でブロックが回避された場合は、この下の bootstrap 用ログで十分なため
      // 重複・誤解を招くログを出さない）。ブロックはしないが、続行する旨を明示的にログへ残す。
      console.error(
        `[db-migrate] --confirm-fresh-apply が指定されているため、真っ新なDBへ ` +
          `${state.pending.length} 件のmigrationを実行します。`
      )
    }

    const executionId = crypto.randomUUID()
    const results = []

    if (bootstrap) {
      console.log(
        `[db-migrate] --bootstrap: 未登録の ${state.pending.length} 件を「実行せずに」履歴登録します` +
          '（実DBは既にこの内容を反映済みという前提）'
      )
      for (const d of state.pending) {
        warningSink.current = d.version
        await sql`
          insert into twica_meta.schema_migrations (version, name, checksum, applied_by, execution_id)
          values (${d.version}, ${d.name}, ${d.checksum}, ${appliedBy}, ${executionId})
        `
        results.push({ version: d.version, name: d.name, outcome: 'bootstrapped' })
        console.log(`  [bootstrapped] ${d.version} ${d.name}`)
      }
      printApplySummary(results, warningSink.list)
      return 0
    }

    if (state.pending.length === 0) {
      console.log('[db-migrate] 適用対象の未適用migrationはありません（no-op）')
      printApplySummary(results, warningSink.list)
      return 0
    }

    for (const d of state.pending) {
      warningSink.current = d.version
      try {
        // d.sourceDir: loadMigrationFilesFromDirs がディレクトリごとに付与した出自
        // （--provider=planetscale では supabase/migrations/ と db/planetscale/migrations/
        // の両方をマージしているため、単一の migrationsDir では正しいファイルを読めない）。
        const content = core.readMigrationFile(d.sourceDir, d.filename)
        if (d.transaction === 'forbidden') {
          // トランザクション外での実行が必須な文（CREATE INDEX CONCURRENTLY等）を含む。
          // SQL実行が成功した後、history insertは別途・非トランザクションで記録する
          // （Issue #692 設計方針）。SQL実行自体が失敗した場合はhistoryに記録せず、
          // 次回再試行できるようにする（非トランザクション実行の性質上、DDLの一部が
          // 既に反映されている可能性はあるが、IF NOT EXISTS等の冪等な書き方を前提とする）。
          // 注意（High-1）: sql.unsafe(content) はファイル全体を1回のsimple queryとして送信するが、
          // PostgreSQLは複数文のsimple queryバッチを暗黙のトランザクションブロックとして実行するため、
          // forbidden ファイルにSQL文が2つ以上あると「cannot run inside a transaction block」で
          // 失敗する。そのためforbiddenは実質的にSQL文1つのみをサポートする。この制約は
          // buildMigrationDescriptor（countEffectiveStatements）でファイル読み込み時点にバリデーション
          // 済みのため、ここに到達する時点で複数文であることは無い想定。
          await sql.unsafe(content)
          await sql`
            insert into twica_meta.schema_migrations (version, name, checksum, applied_by, execution_id)
            values (${d.version}, ${d.name}, ${d.checksum}, ${appliedBy}, ${executionId})
          `
        } else {
          // required / optional はどちらもトランザクション内で実行する（optional は
          // 「トランザクションの有無どちらでも安全」という宣言であり、トランザクション内実行を
          // 禁止するものではない。安全側としてデフォルトのrequiredと同じ扱いにする）。
          // migration成功とhistory insertを同一トランザクションでcommitする。
          await sql.begin(async (tx) => {
            await tx.unsafe(content)
            await tx`
              insert into twica_meta.schema_migrations (version, name, checksum, applied_by, execution_id)
              values (${d.version}, ${d.name}, ${d.checksum}, ${appliedBy}, ${executionId})
            `
          })
        }
        results.push({ version: d.version, name: d.name, outcome: 'applied' })
        console.log(`  [applied] ${d.version} ${d.name} (transaction=${d.transaction})`)
      } catch (error) {
        const message = core.redactSecretsFromText(
          error instanceof Error ? error.message : String(error),
          process.env.DATABASE_URL
        )
        results.push({ version: d.version, name: d.name, outcome: 'failed', error: message })
        console.error(`  [failed] ${d.version} ${d.name}: ${message}`)
        // required/optional はトランザクションがロールバック済み（sql.beginが例外時に自動rollback）。
        // forbidden はhistory insert未実行のまま。どちらも次回再試行可能な状態のため、
        // ここで処理を打ち切り、以降のmigrationは実行しない（順序性を守るため）。
        printApplySummary(results, warningSink.list)
        return 1
      }
    }

    printApplySummary(results, warningSink.list)
    return 0
  } finally {
    warningSink.current = null
    await sql`select pg_advisory_unlock(hashtext(${core.ADVISORY_LOCK_KEY_INPUT}))`
  }
}

async function cmdVerify(sql, migrationsDirs, provider) {
  const state = await computeState(sql, migrationsDirs, provider)
  if (hasBlockingErrors(state)) {
    printBlockingErrors(state)
    console.error('[db-migrate] verify: FAIL')
    return 1
  }

  console.log(
    `[db-migrate] verify: OK (適用済み ${state.applied.length}件, 未適用 ${state.pending.length}件, ` +
      `provider不一致でスキップ ${state.skippedForProvider.length}件)`
  )
  if (!state.historyTableExists) {
    console.log(
      '[db-migrate] 注記: 履歴テーブルが存在しないため、全migrationが「未適用」として扱われています。' +
        'apply --bootstrap または apply の実行を検討してください（このこと自体は verify の失敗要因にはしません）。'
    )
  }
  return 0
}

async function main() {
  const resolved = resolveConfig(process.argv, process.env)

  if (resolved.help) {
    console.log(HELP_TEXT)
    return
  }
  if (resolved.error) {
    console.error(`[db-migrate] ${resolved.error}`)
    console.error('')
    console.error(HELP_TEXT)
    process.exitCode = 1
    return
  }

  const { command, bootstrap, confirmFreshApply, provider, databaseUrl } = resolved
  const warningSink = { current: null, list: [] }
  const sql = createSqlClient(databaseUrl, warningSink)
  const migrationsDirs = resolveMigrationsDirs(provider)

  console.log(`[db-migrate] command=${command} provider=${provider} database=${core.redactConnectionString(databaseUrl)}`)

  // process.exit() は finally の await を待たずにプロセスを落とすため、
  // 終了コードを変数に持ち、接続クローズ後に一度だけ反映する
  // （scripts/verify-db-schema.js と同じパターン）。
  let exitCode = 2
  try {
    if (command === 'status') {
      exitCode = await cmdStatus(sql, migrationsDirs, provider)
    } else if (command === 'plan') {
      exitCode = await cmdPlan(sql, migrationsDirs, provider)
    } else if (command === 'verify') {
      exitCode = await cmdVerify(sql, migrationsDirs, provider)
    } else if (command === 'apply') {
      exitCode = await cmdApply(sql, migrationsDirs, provider, {
        bootstrap,
        confirmFreshApply,
        appliedBy: resolveAppliedBy(process.env),
        warningSink,
      })
    }
  } catch (error) {
    const message = core.redactSecretsFromText(
      error instanceof Error ? error.message : String(error),
      databaseUrl
    )
    console.error(`[db-migrate] 予期しないエラーで終了しました: ${message}`)
    exitCode = 2
  } finally {
    await sql.end({ timeout: 5 })
  }
  process.exitCode = exitCode
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[db-migrate] 予期しない例外で終了しました:', core.redactSecretsFromText(String(error), process.env.DATABASE_URL))
    process.exitCode = 2
  })
}

module.exports = {
  parseArgs,
  resolveConfig,
  resolveAppliedBy,
  hasBlockingErrors,
  shouldBlockFreshApply,
  FRESH_APPLY_PENDING_THRESHOLD,
  resolveMigrationsDirs,
  SUPABASE_MIGRATIONS_DIR,
  PLANETSCALE_MIGRATIONS_DIR,
}
