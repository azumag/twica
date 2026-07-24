#!/usr/bin/env node
'use strict'

// CI guard for Issue #708. Runtime code, deployment configuration, and package
// dependencies must remain unable to construct or address the retired Supabase
// service. Historical migrations/docs are intentionally outside this guard.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')
// TypeScript Compiler API で import 構文を解析する。識別子名の正規表現だけでは
// alias / namespace / dynamic import / re-export による迂回を見逃すため、構文上の
// module provenance を検査する（TypeScript は既にroot devDependency）。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const failures = []
const REQUIRE_OPEN_NEXT = process.argv.includes('--require-open-next')
const REQUIRED_OPEN_NEXT_ARTIFACTS = [
  '.open-next/worker.js',
  '.open-next/middleware/handler.mjs',
  '.open-next/server-functions/default/handler.mjs',
]
const AUX_WORKER_ARTIFACT_BY_FLAG = Object.freeze({
  '--require-error-reporter-production':
    'workers/error-reporter/dist/production/index.js',
  '--require-error-reporter-preview':
    'workers/error-reporter/dist/preview/index.js',
  '--require-overlay-realtime-production':
    'workers/overlay-realtime/dist/production/index.js',
  '--require-overlay-realtime-preview':
    'workers/overlay-realtime/dist/preview/index.js',
})
const REQUIRED_AUX_WORKER_ARTIFACTS = Object.freeze(
  Object.values(AUX_WORKER_ARTIFACT_BY_FLAG),
)

/**
 * CLI flagから今回のjobが生成すべき補助Worker成果物だけを返す。
 *
 * CIは全構成を1回でbuildするため`--require-aux-workers`を使い、deploy jobは
 * 公開対象だけをbuildするため個別flagを使う。対応表を単一化しておくことで、
 * workflowの最適化時に「buildしたがguardしない」「guardするが別成果物を見る」
 * というsilent passを防ぐ。重複flagは同じ成果物を二重検査する必要がないため除く。
 */
function getRequiredAuxWorkerArtifacts(argv = process.argv) {
  if (argv.includes('--require-aux-workers')) {
    return [...REQUIRED_AUX_WORKER_ARTIFACTS]
  }

  return [...new Set(
    Object.entries(AUX_WORKER_ARTIFACT_BY_FLAG)
      .filter(([flag]) => argv.includes(flag))
      .map(([, artifact]) => artifact),
  )]
}

function absolute(relativePath) {
  return path.join(ROOT, relativePath)
}

function read(relativePath) {
  return fs.readFileSync(absolute(relativePath), 'utf8')
}

function fail(message) {
  failures.push(message)
}

/**
 * 実行可能な文字列リテラルは残し、コメントだけを空白へ置換する。
 *
 * shutdown guard は URL や SDK API を文字列で組み立てる回避も検知する必要があるため、
 * 正規表現だけでコメントを消すことはできない。例えば URL リテラルの `https://` を
 * 行コメントと誤認すると、直接接続を見逃してしまう。一方、移行経緯を説明する
 * `PostgREST .rpc()` まで実コードとして報告すると、今回のような偽陽性になる。
 */
function stripComments(source) {
  let result = ''
  let quote = null
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (character === '\n') {
        lineComment = false
        result += character
      } else {
        result += ' '
      }
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        result += '  '
        index += 1
        blockComment = false
      } else {
        result += character === '\n' ? '\n' : ' '
      }
      continue
    }
    if (quote) {
      result += character
      if (character === '\\') {
        result += next || ''
        index += 1
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === '/' && next === '/') {
      result += '  '
      index += 1
      lineComment = true
    } else if (character === '/' && next === '*') {
      result += '  '
      index += 1
      blockComment = true
    } else {
      result += character
      if (character === "'" || character === '"' || character === '`') quote = character
    }
  }
  return result
}

function assertAbsent(relativePath, patterns) {
  const source = stripComments(read(relativePath))
  for (const label of findMatchingPatternLabels(source, patterns)) {
    fail(`${relativePath}: retired Supabase dependency reintroduced (${label})`)
  }
}

function assertRawAbsent(relativePath, patterns) {
  // 通常のruntime検査は歴史コメントを許容するためコメントを除去する。一方、移行済み
  // module内に旧driver helper名が説明として残ると、保守者へ存在しない切替手順を示して
  // しまう。対象を単一moduleへ限定したraw検査を併用し、一般ドキュメントは妨げない。
  const source = read(relativePath)
  for (const label of findMatchingPatternLabels(source, patterns)) {
    fail(`${relativePath}: retired migration language remains (${label})`)
  }
}

function findMatchingPatternLabels(source, patterns) {
  return patterns
    .filter(([, pattern]) => pattern.test(source))
    .map(([label]) => label)
}

function assertPresent(relativePath, patterns) {
  const source = read(relativePath)
  for (const [label, pattern] of patterns) {
    if (!pattern.test(source)) {
      fail(`${relativePath}: shutdown guard missing (${label})`)
    }
  }
}

function assertMissingFile(relativePath) {
  if (fs.existsSync(absolute(relativePath))) {
    fail(`${relativePath}: retired Supabase entry point must remain deleted`)
  }
}

function assertRequiredFile(relativePath) {
  if (!fs.existsSync(absolute(relativePath))) {
    fail(`${relativePath}: required deploy artifact is missing; run workers:build before this guard`)
  }
}

function findMissingRequiredFiles(rootDirectory, relativePaths) {
  return relativePaths.filter(
    (relativePath) => !fs.existsSync(path.join(rootDirectory, relativePath)),
  )
}

const RETIRED_MODULE_PATTERN = /^(?:@supabase\/|@\/lib\/supabase(?:\/|$))/
const RETIRED_CLIENT_METHODS = new Set([
  'from',
  'rpc',
  'channel',
  'removeChannel',
  'auth',
  'storage',
  'functions',
])

/**
 * ASTからmodule specifierを取得する。
 *
 * ImportDeclaration / ExportDeclarationに加え、`require()` と `import()` も
 * CallExpressionとして扱う。文字列コメントや説明用の通常文字列はmodule loaderの
 * 引数ではないので検知せず、実行可能な依存だけを拒否できる。
 */
function getLoadedModuleSpecifier(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier
    && ts.isStringLiteralLike(node.moduleSpecifier)) {
    return node.moduleSpecifier.text
  }
  if (!ts.isCallExpression(node) || node.arguments.length !== 1
    || !ts.isStringLiteralLike(node.arguments[0])) {
    return null
  }
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node.arguments[0].text
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
    return node.arguments[0].text
  }
  return null
}

/**
 * Supabase SDK由来のbindingを追跡して、別名clientのruntime method呼出しを検知する。
 *
 * SDK importそのものも禁止だが、ここでsymbol由来を保持することで `backend.from()`
 * のようにローカル変数名を変えた場合も「supabase」という名前に依存しない。
 * local re-export/wrapperは元ファイル側のimportも全runtime sourceをAST走査するため
 * 必ず拒否され、consumer側の名前だけでは検査結果を左右しない。
 */
function findRetiredAstDependencies(relativePath, source) {
  const extension = path.extname(relativePath)
  const scriptKind = extension === '.tsx'
    ? ts.ScriptKind.TSX
    : extension === '.jsx'
      ? ts.ScriptKind.JSX
      : ['.js', '.mjs', '.cjs'].includes(extension)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const providerBindings = new Map()
  const clientBindings = new Set()
  const astFailures = []

  function markProviderImports(node) {
    const moduleSpecifier = getLoadedModuleSpecifier(node)
    if (moduleSpecifier && RETIRED_MODULE_PATTERN.test(moduleSpecifier)) {
      astFailures.push(
        `${relativePath}: retired Supabase module loaded through executable syntax (${moduleSpecifier})`,
      )
    }
    if (!ts.isImportDeclaration(node)
      || !ts.isStringLiteralLike(node.moduleSpecifier)
      || !RETIRED_MODULE_PATTERN.test(node.moduleSpecifier.text)
      || !node.importClause) {
      ts.forEachChild(node, markProviderImports)
      return
    }

    if (node.importClause.name) {
      providerBindings.set(node.importClause.name.text, 'factory')
    }
    const bindings = node.importClause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) {
      providerBindings.set(bindings.name.text, 'namespace')
    } else if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text || element.name.text
        providerBindings.set(
          element.name.text,
          importedName === 'createClient' ? 'factory' : 'provider',
        )
      }
    }
    ts.forEachChild(node, markProviderImports)
  }
  markProviderImports(sourceFile)

  function getRequiredProviderKind(expression) {
    if (!ts.isCallExpression(expression)
      || expression.arguments.length !== 1
      || !ts.isIdentifier(expression.expression)
      || expression.expression.text !== 'require'
      || !ts.isStringLiteralLike(expression.arguments[0])
      || !RETIRED_MODULE_PATTERN.test(expression.arguments[0].text)) {
      return null
    }
    return 'namespace'
  }

  // CommonJSのnamespace aliasとdestructuringもES importと同じprovenanceへ正規化する。
  // module load自体のFAILに加え、以後の変数名が変わってもclient method由来を説明できる。
  function collectCommonJsProviderBindings(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const providerKind = getRequiredProviderKind(node.initializer)
      if (providerKind && ts.isIdentifier(node.name)) {
        providerBindings.set(node.name.text, providerKind)
      }
      if (ts.isObjectBindingPattern(node.name)
        && ts.isIdentifier(node.initializer)
        && providerBindings.get(node.initializer.text) === 'namespace') {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue
          const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text
          providerBindings.set(
            element.name.text,
            importedName === 'createClient' ? 'factory' : 'provider',
          )
        }
      }
    }
    ts.forEachChild(node, collectCommonJsProviderBindings)
  }
  collectCommonJsProviderBindings(sourceFile)

  function expressionCreatesClient(expression) {
    if (!ts.isCallExpression(expression)) return false
    const callee = expression.expression
    if (ts.isIdentifier(callee)) {
      return providerBindings.get(callee.text) === 'factory'
    }
    return ts.isPropertyAccessExpression(callee)
      && ts.isIdentifier(callee.expression)
      && providerBindings.get(callee.expression.text) === 'namespace'
      && callee.name.text === 'createClient'
  }

  // alias chain (`const api = backend`)も順序に依存せず収束するまで伝播する。
  let changed = true
  while (changed) {
    changed = false
    function collectClientBindings(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const isClient = expressionCreatesClient(node.initializer)
          || (ts.isIdentifier(node.initializer) && clientBindings.has(node.initializer.text))
        if (isClient && !clientBindings.has(node.name.text)) {
          clientBindings.add(node.name.text)
          changed = true
        }
      }
      ts.forEachChild(node, collectClientBindings)
    }
    collectClientBindings(sourceFile)
  }

  function checkClientCalls(node) {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && clientBindings.has(node.expression.expression.text)
      && RETIRED_CLIENT_METHODS.has(node.expression.name.text)) {
      astFailures.push(
        `${relativePath}: retired Supabase client method called from provider-derived binding `
        + `(${node.expression.name.text})`,
      )
    }
    ts.forEachChild(node, checkClientCalls)
  }
  checkClientCalls(sourceFile)
  return astFailures
}

function assertNoRetiredAstDependencies(relativePath) {
  for (const message of findRetiredAstDependencies(relativePath, read(relativePath))) {
    fail(message)
  }
}

function walk(
  relativeDirectory,
  // Node/TypeScriptは .mts/.cts も実行可能entry pointであり、ここを除外すると
  // 拡張子を変えるだけでshutdown境界を迂回できる。sourceとbuild artifactの
  // 両方を同じ集合で検査する。
  filePattern = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/,
) {
  const root = absolute(relativeDirectory)
  if (!fs.existsSync(root)) return []
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryAbsolute = path.join(root, entry.name)
    const relative = path.relative(ROOT, entryAbsolute).split(path.sep).join('/')
    if (entry.isDirectory()) files.push(...walk(relative, filePattern))
    else if (filePattern.test(entry.name)) files.push(relative)
  }
  return files
}

const runtimePatterns = [
  // Match every identifier form (`process.env.*`, Workers `env.*`, destructuring,
  // and string-key lookups). Restricting this to process.env would leave a
  // straightforward bypass for Cloudflare bindings.
  ['Supabase runtime environment identifier', /\b(?:NEXT_PUBLIC_)?SUPABASE_[A-Z0-9_]+\b/],
  ['retired Hyperdrive binding', /\bHYPERDRIVE_SUPABASE\b/],
  ['retired database URL', /\bDATABASE_URL_SUPABASE\b/],
  // Runtime fallback must use PostgreSQL SQLSTATE directly. Provider-specific
  // HTTP error codes would keep an undeclared dependency on the retired API.
  ['retired PostgREST error code', /\bPGRST\d+\b/],
  // Match the identifier anywhere, not only `process.env.*`: Workers bindings,
  // destructured env objects, or a string-key lookup would otherwise bypass the
  // shutdown invariant while still restoring the retired runtime switch.
  ['retired driver switch', /\b(?:DB_DRIVER|GACHA_DB_DRIVER|DB_TARGET)\b/],
  // SDKを使わずfetch/WebSocketで直接接続する退行も拒否する。hostnameと
  // provider API pathを別々に検査するため、URLをテンプレート文字列で組み立てる
  // 場合でも少なくとも片側が検知される。
  ['direct Supabase project host', /(?:https?:\/\/|wss?:\/\/)?[a-z0-9-]+\.supabase\.co\b/i],
  ['direct PostgREST API path', /\/rest\/v1(?:\/|\b)/i],
  ['direct Supabase Realtime API path', /\/realtime\/v1(?:\/|\b)/i],
  ['direct Supabase Auth API path', /\/auth\/v1(?:\/|\b)/i],
  ['direct Supabase Storage API path', /\/storage\/v1(?:\/|\b)/i],
  ['direct Supabase Functions API path', /\/functions\/v1(?:\/|\b)/i],
]
const generatedBundlePatterns = [
  ...runtimePatterns,
  // bundle後は元のimport構文が消えて単なるmodule id文字列だけ残る場合がある。
  // sourceのAST検査と独立したliteral scanを併用し、生成器による再注入も拒否する。
  ['Supabase package literal', /@supabase\//],
  // Supabase Realtime clientが使うPhoenix channel protocolの代表的なevent名。
  // application sourceにはこの文字列を使う独自protocolが無いため、bundle内では
  // retired Realtime実装の残存シグナルとして安全に扱える。
  ['Supabase Realtime protocol marker', /\b(?:phx_join|postgres_changes)\b/],
]
// `.opencode/plans` はagent/operatorが次の変更判断に直接使う「現行の計画面」。
// runtime sourceだけを守っても、ここに退役providerのsecret追加や旧Vercel deploy
// 手順が残ると、そのまま再導入される。履歴資料はdocs/historyへ隔離し、現行plan
// だけを厳しく検査する。
const currentPlanPatterns = [
  ...runtimePatterns,
  ['Supabase CLI action', /supabase\/setup-cli|\bsupabase\s+db\s+push\b/i],
  ['Supabase browser/build variable', /\bNEXT_PUBLIC_SUPABASE_/],
  ['Supabase elevated key', /\bSUPABASE_(?:SECRET|SERVICE_ROLE)_KEY\b/],
  ['retired Vercel deployment path', /\b(?:Vercel auto-deploy|Vercel CLI|vercel\s+(?:deploy|--prod))\b/i],
]

if (require.main === module) {
const runtimeSourceFiles = [
  ...walk('src'),
  ...walk('workers'),
  ...walk('analysis/src'),
  ...walk('analysis/dev'),
]
for (const file of runtimeSourceFiles) {
  assertNoRetiredAstDependencies(file)
  assertAbsent(file, runtimePatterns)
}

for (const file of walk('.opencode/plans', /\.md$/)) {
  assertAbsent(file, currentPlanPatterns)
}

assertRawAbsent('src/lib/twitch/token-manager.ts', [
  [
    'driver helper reference',
    /\b(?:isPgReadEnabled|isPgWriteEnabled|getGachaDbDriver)\b/,
  ],
])
assertRawAbsent('src/lib/services/gacha.ts', [
  [
    'retired gacha helper reference',
    /\b(?:executeGachaLegacy|isPgReadEnabled|isPgWriteEnabled|getGachaDbDriver)\b/,
  ],
])

// package scriptsから到達するroot-level runtime/deploy entry pointも検査する。
// `scripts/`全体には移行履歴のexport utilityがあり、過去provider名の記録自体は
// 正当なので、現在のproduction実行面だけを明示列挙する。
for (const file of [
  'scripts/cloudflare-workers-build-deploy.sh',
  'scripts/smoke-check.js',
  'scripts/replay-maintenance-eventsub.js',
  'scripts/probe-maintenance-write-surfaces.js',
]) {
  if (fs.existsSync(absolute(file))) {
    assertNoRetiredAstDependencies(file)
    assertAbsent(file, runtimePatterns)
  }
}

// CIのbuild後に再実行したときだけ存在する成果物も検査する。source guardだけ
// ではbundler pluginや生成設定が直接REST endpointを注入する退行を見逃すため、
// root app・OpenNext Worker・analysis・各Workerの生成JSを同じ規則で確認する。
for (const artifactRoot of [
  '.next',
  '.open-next',
  'analysis/dist',
  'workers/error-reporter/dist',
  'workers/overlay-realtime/dist',
]) {
  for (const file of walk(artifactRoot)) {
    assertAbsent(file, generatedBundlePatterns)
  }
}

if (REQUIRE_OPEN_NEXT) {
  // deployに必須のroot WorkerとEdge middleware chunkを個別に要求する。ディレクトリの
  // 存在だけでは、出力構成変更でwalkが0件になった際にsilent passしてしまう。
  for (const artifact of REQUIRED_OPEN_NEXT_ARTIFACTS) assertRequiredFile(artifact)

  if (fs.existsSync(absolute('.open-next/middleware/handler.mjs'))) {
    assertAbsent('.open-next/middleware/handler.mjs', [
      // Edge middlewareへserver loggerが到達するとpostgres/DB clientまでbundleされる。
      // import元の名前と生成後の代表symbol/bindingを併記して、tree-shaking結果に
      // 依存せず本番Edge境界を守る。
      ['server-only logger in Edge middleware', /(?:logger\.server|logErrorFromLogger)/],
      ['database client in Edge middleware', /\b(?:postgres|HYPERDRIVE_PLANETSCALE)\b/i],
    ])
  }
}
// deploy workflowでは、そのjobが実際に公開するWorker/環境だけをbuildする。全4 bundleを
// jobごとに重複生成せず、それでも未build成果物のsilent passを許さないよう個別flagで
// 対応する1ファイルを必須化する。CIは--require-aux-workersで全構成を検査する。
for (const artifact of getRequiredAuxWorkerArtifacts()) assertRequiredFile(artifact)

// Test-only aliases and facades can hide a production import after its source
// module is deleted. Reject those local compatibility entry points as well,
// while leaving the dedicated browser-guard fixtures free to contain literal
// `@supabase/*` examples that prove the detector itself.
for (const file of walk('tests')) {
  assertAbsent(file, [
    [
      'retired local database module import',
      /(?:from\s+|require\(\s*|import\(\s*)['"]@\/lib\/(?:supabase\/(?:admin|middleware|retry)|db\/(?:flags|target))['"]/,
    ],
    ['retired PostgREST error fixture', /\bPGRST\d+\b/],
    [
      'retired driver-switch fixture',
      /(?:stubEnv\(\s*['"]|process\.env\.)(?:DB_DRIVER|GACHA_DB_DRIVER|DB_TARGET|TWICA_ENABLE_LEGACY_SUPABASE)\b/,
    ],
  ])
}
for (const configFile of ['tsconfig.json', 'vitest.config.ts']) {
  assertAbsent(configFile, [
    [
      'retired test-only database alias',
      /@\/lib\/(?:supabase\/(?:admin|middleware|retry)|db\/(?:flags|target))/,
    ],
  ])
}

for (const retiredPath of [
  'src/lib/supabase/admin.ts',
  'src/lib/supabase/client.ts',
  'src/lib/supabase/server.ts',
  'src/lib/supabase/index.ts',
  'src/lib/supabase/keys.ts',
  'src/lib/supabase/retry.ts',
  'src/lib/supabase/middleware.ts',
  'src/lib/db/flags.ts',
  'src/lib/db/target.ts',
  'tests/utils/supabase-mock.ts',
  'scripts/init-storage-usage.js.deprecated',
  'scripts/migrate-vercel-blob-to-r2.js',
]) {
  assertMissingFile(retiredPath)
}

for (const workflow of walk('.github/workflows', /\.ya?ml$/)) {
  // YAMLの実行可能な値へsource runtimeと同じ包括規則を適用する。これにより
  // URL/key名だけでなくcurlのREST/Realtime/Auth等の直接endpointも拒否する。
  assertAbsent(workflow, runtimePatterns)
  assertAbsent(workflow, [
    ['Supabase CLI action', /supabase\/setup-cli/],
    ['Supabase migration command', /supabase\s+db\s+push/],
    ['Supabase database secret', /SUPABASE_DB_URL/],
    ['Supabase browser/build variable', /NEXT_PUBLIC_SUPABASE_/],
    ['Supabase elevated key', /SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY/],
  ])
}

for (const configFile of [
  'wrangler.toml',
  'workers/error-reporter/wrangler.toml',
  'workers/overlay-realtime/wrangler.toml',
  '.env.local.example',
]) {
  assertAbsent(configFile, runtimePatterns)
}
assertPresent('wrangler.toml', [
  ['production PlanetScale binding', /binding\s*=\s*['"]HYPERDRIVE_PLANETSCALE['"]/],
  ['preview PlanetScale binding', /env\.preview\.hyperdrive/],
])
assertAbsent('.env.local.example', [
  ['Supabase public URL', /NEXT_PUBLIC_SUPABASE_URL/],
  ['Supabase elevated key', /SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY/],
  ['retired driver switch', /(?:DB_DRIVER|GACHA_DB_DRIVER|DB_TARGET)/],
])
assertPresent('.env.local.example', [
  ['PlanetScale local URL', /DATABASE_URL_PLANETSCALE/],
])

assertPresent('.github/workflows/planetscale-migrate.yml', [
  ['provider-neutral migration apply', /db-migrate\.js\s+apply\s+--provider=planetscale/],
  ['provider-neutral migration verify', /db-migrate\.js\s+verify\s+--provider=planetscale/],
  ['PlanetScale migration secret', /PLANETSCALE_DATABASE_URL/],
])
assertAbsent('.github/workflows/deploy-cloudflare.yml', [
  ['duplicate migration runner', /(?:db-migrate\.js|db:migrate:(?:apply|verify))/],
  ['migration-capable database secret', /PLANETSCALE_DATABASE_URL/],
])

for (const packagePath of [
  'package.json',
  'analysis/package.json',
  'workers/error-reporter/package.json',
]) {
  const manifest = JSON.parse(read(packagePath))
  for (const dependencyName of Object.keys({
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
  })) {
    if (dependencyName === 'supabase' || dependencyName.startsWith('@supabase/')) {
      fail(`${packagePath}: retired Supabase package remains (${dependencyName})`)
    }
  }
}
for (const lockfilePath of ['package-lock.json', 'analysis/package-lock.json']) {
  if (!fs.existsSync(absolute(lockfilePath))) continue
  assertAbsent(lockfilePath, [
    ['transitive Supabase package', /node_modules\/(?:@supabase\/|supabase["/])/],
  ])
}

const packageJson = JSON.parse(read('package.json'))
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  if (/\bnpx\s+supabase\b|\bsupabase\s+db\b/.test(String(command))) {
    fail(`package.json scripts.${name}: invokes the retired Supabase CLI path`)
  }
}
for (const scriptName of [
  'db:status',
  'db:push',
  'db:push:dry',
  'db:migrate:status',
  'db:migrate:plan',
  'db:migrate:apply',
  'db:migrate:verify',
]) {
  if (!String(packageJson.scripts?.[scriptName] || '').includes('--provider=planetscale')) {
    fail(`package.json scripts.${scriptName}: must target PlanetScale`)
  }
}

if (failures.length > 0) {
  console.error('Supabase shutdown guard failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('OK: runtime, dependencies, bindings, environment, and deploy paths are independent of Supabase')
}

module.exports = {
  REQUIRED_AUX_WORKER_ARTIFACTS,
  REQUIRED_OPEN_NEXT_ARTIFACTS,
  findGeneratedBundleDependencies: (source) => (
    findMatchingPatternLabels(stripComments(source), generatedBundlePatterns)
  ),
  findRetiredCurrentPlanDependencies: (source) => (
    findMatchingPatternLabels(stripComments(source), currentPlanPatterns)
  ),
  findMissingRequiredFiles,
  findRetiredAstDependencies,
  getRequiredAuxWorkerArtifacts,
  stripComments,
}
