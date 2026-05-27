import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const migrationsDir = resolve(__dirname, '../../supabase/migrations')

const normalizeIdentifier = (identifier: string) => identifier.replaceAll('"', '').toLowerCase()

const tableKey = (schema: string | undefined, table: string) =>
  `${normalizeIdentifier(schema ?? 'public')}.${normalizeIdentifier(table)}`

const tableGrantPattern = (table: string, role: string) =>
  new RegExp(
    `GRANT\\s+[^;]+\\s+ON\\s+TABLE\\s+public\\.${table}\\s+TO\\s+${role}\\b`,
    'i',
  )

describe('Supabase migration RLS coverage', () => {
  it('enables row-level security for every public table created by migrations', () => {
    const createdPublicTables = new Map<string, string>()
    const rlsEnabledTables = new Set<string>()

    for (const file of readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort()) {
      const sql = readFileSync(resolve(migrationsDir, file), 'utf-8')

      for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+|"\w+")\.)?(\w+|"\w+")/gi)) {
        const key = tableKey(match[1], match[2])

        if (key.startsWith('public.')) {
          createdPublicTables.set(key, file)
        }
      }

      for (const match of sql.matchAll(/ALTER\s+TABLE\s+(?:(\w+|"\w+")\.)?(\w+|"\w+")\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi)) {
        rlsEnabledTables.add(tableKey(match[1], match[2]))
      }
    }

    const missingRls = [...createdPublicTables.entries()]
      .filter(([table]) => !rlsEnabledTables.has(table))
      .map(([table, file]) => `${table} created in ${file}`)

    expect(missingRls).toEqual([])
  })

  it('grants service_role Data API access explicitly for every public table', () => {
    const createdPublicTables = new Map<string, string>()
    const allMigrationsSql = readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort()
      .map(file => {
        const sql = readFileSync(resolve(migrationsDir, file), 'utf-8')

        for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+|"\w+")\.)?(\w+|"\w+")/gi)) {
          const key = tableKey(match[1], match[2])

          if (key.startsWith('public.')) {
            createdPublicTables.set(key, file)
          }
        }

        return sql
      })
      .join('\n')

    const missingGrants = [...createdPublicTables.entries()]
      .filter(([table]) => {
        const [, tableName] = table.split('.')

        return !tableGrantPattern(tableName, 'service_role').test(allMigrationsSql)
      })
      .map(([table, file]) => `${table} created in ${file}`)

    expect(missingGrants).toEqual([])
  })

  it('keeps browser-visible table grants limited to intended read-only surfaces', () => {
    const migration = readFileSync(
      resolve(migrationsDir, '00047_explicit_public_table_grants.sql'),
      'utf-8',
    )

    expect(migration).toMatch(/GRANT\s+SELECT\s+ON\s+TABLE\s+public\.streamers\s+TO\s+anon,\s*authenticated/i)
    expect(migration).toMatch(/GRANT\s+SELECT\s+ON\s+TABLE\s+public\.cards\s+TO\s+anon,\s*authenticated/i)
    expect(migration).toMatch(/GRANT\s+SELECT\s+ON\s+TABLE\s+public\.streamer_additional_gacha_rewards\s+TO\s+authenticated/i)
    expect(migration).not.toMatch(/GRANT\s+[^;]*INSERT[^;]*TO\s+anon/i)
    expect(migration).not.toMatch(/GRANT\s+[^;]*UPDATE[^;]*TO\s+anon/i)
    expect(migration).not.toMatch(/GRANT\s+[^;]*DELETE[^;]*TO\s+anon/i)
  })

  it('keeps channel point usage stats restricted to service role table access', () => {
    const migration = readFileSync(
      resolve(migrationsDir, '00045_enable_channel_point_usage_stats_rls.sql'),
      'utf-8',
    )

    expect(migration).toContain('ALTER TABLE channel_point_usage_stats ENABLE ROW LEVEL SECURITY')
    expect(migration).toMatch(/ON\s+channel_point_usage_stats\s+FOR\s+ALL\s+TO\s+service_role/i)
    expect(migration).toMatch(/WITH\s+CHECK\s+\(true\)/i)
  })
})
