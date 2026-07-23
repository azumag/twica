#!/usr/bin/env node
'use strict'

// This guard is executed directly by Node as a CommonJS package script. Keep
// the built-in imports in require form so the shutdown check has no transpiler
// or module-loader dependency in CI.
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

function assertAbsent(relativePath, patterns) {
  const source = read(relativePath)
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

function walk(relativeDirectory) {
  const root = absolute(relativeDirectory)
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryAbsolute = path.join(root, entry.name)
    const relative = path.relative(ROOT, entryAbsolute).split(path.sep).join('/')
    if (entry.isDirectory()) files.push(...walk(relative))
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(relative)
  }
  return files
}

const srcFiles = walk('src')

// Browser and route code must never import a Supabase runtime SDK again. The
// compatibility type/adapters are deliberately isolated under src/lib/supabase/.
for (const file of [...walk('src/app'), ...walk('src/components')]) {
  assertAbsent(file, [
    ['Supabase SDK import', /from\s+['"]@supabase\//],
    ['Supabase SDK require', /require\(\s*['"]@supabase\//],
    // 「SDK を import していないが、診断ログや条件分岐だけが廃止済み URL/鍵を
    // 読む」退行も、Supabase secret を削除した preview で初めて露見する。
    // アプリ境界では値の用途にかかわらず禁止し、互換 facade は lib 内に隔離する。
    ['Supabase URL/key lookup', /(?:NEXT_PUBLIC_)?SUPABASE_(?:URL|KEY|SECRET|SERVICE|ANON)/],
  ])
}

// Full call-site inventory for issue #687. A dormant getSupabaseAdmin() handle
// is harmless, but every file that can obtain one must also contain a pg/gacha
// driver branch. This rejects newly added Supabase-only functions.
for (const file of srcFiles) {
  if (file === 'src/lib/supabase/admin.ts') continue
  const source = read(file)
  if (!/\bgetSupabaseAdmin(?:NoCache)?\s*\(/.test(source)) continue

  if (!/\b(?:isPgReadEnabled|isPgWriteEnabled|getGachaDbDriver)\b/.test(source)) {
    fail(`${file}: getSupabaseAdmin call has no pg/gacha driver branch`)
  }
}

for (const retiredPath of [
  'src/lib/supabase/client.ts',
  'src/lib/supabase/server.ts',
  'src/lib/supabase/index.ts',
  'src/lib/supabase/keys.ts',
  'scripts/migrate-vercel-blob-to-r2.js',
]) {
  assertMissingFile(retiredPath)
}

assertAbsent('src/lib/realtime.ts', [
  ['Supabase SDK import', /@supabase\//],
  ['Supabase public URL', /NEXT_PUBLIC_SUPABASE_URL/],
  ['Supabase client construction', /\bcreateClient\s*\(/],
])

assertAbsent('src/app/api/gacha/demo/route.ts', [
  ['Supabase SDK import', /@supabase\//],
  ['Supabase URL/key', /(?:NEXT_PUBLIC_)?SUPABASE_(?:URL|KEY|SECRET|SERVICE)/],
  ['Realtime broadcast', /broadcastGachaResult/],
])

assertAbsent('src/lib/supabase/admin.ts', [
  ['runtime SDK factory import', /import\s*\{[^}]*\bcreateClient\b/],
  ['runtime SDK construction', /\bcreateClient\s*\(/],
  ['Supabase URL/key lookup', /(?:NEXT_PUBLIC_)?SUPABASE_(?:URL|KEY|SECRET|SERVICE)/],
])

for (const workflow of [
  '.github/workflows/deploy-cloudflare.yml',
  '.github/workflows/smoke-check.yml',
]) {
  assertAbsent(workflow, [
    ['Supabase CLI action', /supabase\/setup-cli/],
    ['Supabase migration command', /supabase\s+db\s+push/],
    ['Supabase database secret', /SUPABASE_DB_URL/],
    ['Supabase browser/build variable', /NEXT_PUBLIC_SUPABASE_/],
    ['Supabase elevated key', /SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY/],
  ])
}

assertAbsent('scripts/smoke-check.js', [
  ['Supabase SDK', /@supabase\//],
  ['Supabase credential', /(?:NEXT_PUBLIC_)?SUPABASE_(?:URL|KEY|SECRET|SERVICE)/],
  ['PostgREST query client', /\.from\(['"]/],
])
assertPresent('scripts/smoke-check.js', [
  ['postgres.js client', /require\(['"]postgres['"]\)/],
  ['information_schema query', /information_schema\.(?:columns|tables)/],
])
assertPresent('.github/workflows/smoke-check.yml', [
  ['PlanetScale smoke secret', /PLANETSCALE_DATABASE_URL/],
])

assertAbsent('wrangler.toml', [
  ['retired application Hyperdrive binding', /HYPERDRIVE_SUPABASE/],
])
assertPresent('wrangler.toml', [
  ['production PlanetScale binding', /binding\s*=\s*['"]HYPERDRIVE_PLANETSCALE['"]/],
  ['preview PlanetScale binding', /env\.preview\.hyperdrive/],
])

assertAbsent('.env.local.example', [
  ['Supabase public URL', /NEXT_PUBLIC_SUPABASE_URL/],
  ['Supabase elevated key', /SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY/],
  ['Supabase database URL', /SUPABASE_DB_URL/],
])
assertPresent('.env.local.example', [
  ['PlanetScale local URL', /DATABASE_URL_PLANETSCALE/],
])

// Migration execution must stay in its own non-cancelling workflow. If it is
// moved back into deploy-cloudflare.yml, that workflow's cancel-in-progress
// policy can terminate transaction-forbidden DDL and leave manual cleanup.
assertPresent('.github/workflows/planetscale-migrate.yml', [
  ['provider-neutral migration apply', /db-migrate\.js\s+apply\s+--provider=planetscale/],
  ['provider-neutral migration verify', /db-migrate\.js\s+verify\s+--provider=planetscale/],
  ['PlanetScale migration secret', /PLANETSCALE_DATABASE_URL/],
])
assertAbsent('.github/workflows/deploy-cloudflare.yml', [
  ['duplicate migration runner', /(?:db-migrate\.js|db:migrate:(?:apply|verify))/],
  ['migration-capable database secret', /PLANETSCALE_DATABASE_URL/],
])

assertPresent('src/lib/db/flags.ts', [
  ['explicit legacy gate', /TWICA_ENABLE_LEGACY_SUPABASE/],
  ['test-only legacy gate', /NODE_ENV\s*===\s*['"]test['"]/],
  ['pg fail-safe default', /return\s+['"]pg['"]/],
])
assertPresent('src/lib/db/target.ts', [
  ['PlanetScale fail-safe default', /return\s+['"]planetscale['"]/],
  ['legacy target gate', /isLegacySupabaseEnabled/],
])
assertPresent('src/lib/supabase/admin.ts', [
  ['non-instantiating retired facade', /createRetiredSupabaseClient/],
  ['precise leaked-path failure', /Retired runtime path accessed/],
])
assertPresent('analysis/vite.config.ts', [
  ['analysis pg default', /ANALYSIS_DB_DRIVER\s*=\s*['"]pg['"]/],
])

const envValidation = read('src/lib/env-validation.ts')
if (/name:\s*['"][^'"]*SUPABASE/.test(envValidation)) {
  fail('src/lib/env-validation.ts: Supabase variable is required at startup')
}

const packageJson = JSON.parse(read('package.json'))
for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  if (/\bnpx\s+supabase\b|\bsupabase\s+db\b/.test(String(command))) {
    fail(`package.json scripts.${name}: invokes the retired Supabase CLI path`)
  }
  if (/migrate-vercel-blob-to-r2/.test(String(command))) {
    fail(`package.json scripts.${name}: invokes the retired Supabase-backed storage migration`)
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

console.log('OK: admin call sites, runtime, overlay, monitoring, startup validation, bindings, and deploy paths are independent of Supabase')
