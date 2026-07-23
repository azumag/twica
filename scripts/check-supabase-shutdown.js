#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const failures = []

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
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

function walk(relativeDirectory) {
  const root = path.join(ROOT, relativeDirectory)
  const files = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    const relative = path.relative(ROOT, absolute).split(path.sep).join('/')
    if (entry.isDirectory()) files.push(...walk(relative))
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(relative)
  }
  return files
}

// Browser and route code must never import a Supabase runtime SDK again. The
// compatibility type/adapters are deliberately isolated under src/lib/supabase/.
for (const file of [...walk('src/app'), ...walk('src/components')]) {
  assertAbsent(file, [
    ['Supabase SDK import', /from\s+['"]@supabase\//],
    ['Supabase SDK require', /require\(\s*['"]@supabase\//],
  ])
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

assertAbsent('.github/workflows/deploy-cloudflare.yml', [
  ['Supabase CLI action', /supabase\/setup-cli/],
  ['Supabase migration command', /supabase\s+db\s+push/],
  ['Supabase database secret', /SUPABASE_DB_URL/],
  ['Supabase browser build variable', /NEXT_PUBLIC_SUPABASE_/],
])

assertPresent('.github/workflows/deploy-cloudflare.yml', [
  ['provider-neutral migration apply', /npm\s+run\s+db:migrate:apply/],
  ['provider-neutral migration verify', /npm\s+run\s+db:migrate:verify/],
  ['PlanetScale migration secret', /PLANETSCALE_DATABASE_URL/],
])

assertPresent('src/lib/db/flags.ts', [
  ['explicit legacy gate', /TWICA_ENABLE_LEGACY_SUPABASE/],
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

console.log('OK: runtime, overlay, startup validation, and deploy paths are independent of Supabase')
