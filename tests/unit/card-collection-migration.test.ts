import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('card collection migration', () => {
  it('adds card and reward collection-name columns without public RLS policies', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../supabase/migrations/00049_add_card_collection_names.sql'),
      'utf8'
    )

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS collection_name TEXT')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS channel_point_collection_name TEXT')
    expect(sql).toContain('streamer_additional_gacha_rewards')
    expect(sql).not.toMatch(/FOR ALL\s+USING\s*\(true\)/i)
  })
})
