import { describe, expect, it } from 'vitest'
import { readdirSync } from 'fs'
import { resolve } from 'path'

describe('Supabase migration filenames', () => {
  it('use unique version prefixes', () => {
    const migrationsDir = resolve(__dirname, '../../supabase/migrations')
    const migrations = readdirSync(migrationsDir).filter(file => file.endsWith('.sql'))
    const versions = new Map<string, string[]>()

    for (const migration of migrations) {
      const version = migration.match(/^(\d+)_/)?.[1]

      expect(version, `${migration} must start with a numeric version prefix`).toBeDefined()

      const versionMigrations = versions.get(version!) ?? []
      versionMigrations.push(migration)
      versions.set(version!, versionMigrations)
    }

    const duplicates = [...versions.entries()].filter(([, files]) => files.length > 1)

    expect(duplicates).toEqual([])
  })
})
