import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('collection name migration', () => {
  it('adds nullable collection_name to streamers', () => {
    const migration = readFileSync(
      resolve(__dirname, '../../supabase/migrations/00048_add_collection_name_to_streamers.sql'),
      'utf8'
    )

    expect(migration).toMatch(/ALTER TABLE streamers/i)
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS collection_name TEXT/i)
  })
})
