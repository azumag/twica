#!/usr/bin/env node
'use strict'

// CI guard for Issue #708. Runtime code, deployment configuration, and package
// dependencies must remain unable to construct or address the retired Supabase
// service. Historical migrations/docs are intentionally outside this guard.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const failures = []

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
  for (const [label, pattern] of patterns) {
    if (pattern.test(source)) {
      fail(`${relativePath}: retired Supabase dependency reintroduced (${label})`)
    }
  }
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

if (require.main === module) {
const runtimePatterns = [
  ['Supabase SDK import', /(?:from\s+|require\(\s*|import\(\s*)['"]@supabase\//],
  ['retired Supabase module import', /(?:from\s+|require\(\s*|import\(\s*)['"]@\/lib\/supabase\//],
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
  // import名をaliasしても、retired client由来の主要APIメソッド呼び出しは
  // provenance名から検知する。Drizzleの `.from()` は対象に含めない。
  [
    'retired Supabase client method',
    /\b(?:supabase|supabaseAdmin|supabaseClient|postgrest)(?:Client)?\s*\.\s*(?:from|rpc|channel|removeChannel|auth|storage|functions)\b/i,
  ],
]

for (const file of [
  ...walk('src'),
  ...walk('workers'),
  ...walk('analysis/src'),
  ...walk('analysis/dev'),
]) {
  assertAbsent(file, runtimePatterns)
}

// package scriptsから到達するroot-level runtime/deploy entry pointも検査する。
// `scripts/`全体には移行履歴のexport utilityがあり、過去provider名の記録自体は
// 正当なので、現在のproduction実行面だけを明示列挙する。
for (const file of [
  'scripts/cloudflare-workers-build-deploy.sh',
  'scripts/smoke-check.js',
  'scripts/replay-maintenance-eventsub.js',
  'scripts/probe-maintenance-write-surfaces.js',
]) {
  if (fs.existsSync(absolute(file))) assertAbsent(file, runtimePatterns)
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
    assertAbsent(file, runtimePatterns)
  }
}

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
  assertAbsent(workflow, [
    ['Supabase CLI action', /supabase\/setup-cli/],
    ['Supabase migration command', /supabase\s+db\s+push/],
    ['Supabase database secret', /SUPABASE_DB_URL/],
    ['Supabase browser/build variable', /NEXT_PUBLIC_SUPABASE_/],
    ['Supabase elevated key', /SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY/],
  ])
}

assertAbsent('wrangler.toml', [
  ['retired application Hyperdrive binding', /HYPERDRIVE_SUPABASE/],
])
assertAbsent('workers/error-reporter/wrangler.toml', [
  ['retired reporter Hyperdrive binding', /binding\s*=\s*['"]HYPERDRIVE_SUPABASE['"]/],
])
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

module.exports = { stripComments }
