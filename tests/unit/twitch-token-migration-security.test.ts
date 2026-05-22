import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('encrypted Twitch token migration', () => {
  const migration = readFileSync(
    resolve(__dirname, '../../supabase/migrations/00054_add_encrypted_twitch_oauth_tokens.sql'),
    'utf8',
  )

  it('stores OAuth tokens in a dedicated encrypted-token table', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS twitch_oauth_tokens')
    expect(migration).toContain('encrypted_access_token TEXT NOT NULL')
    expect(migration).toContain('encrypted_refresh_token TEXT NOT NULL')
    expect(migration).not.toMatch(/^\s*access_token\s+TEXT\s+NOT NULL/im)
    expect(migration).not.toMatch(/^\s*refresh_token\s+TEXT\s+NOT NULL/im)
  })

  it('limits token table access to service_role RLS policy', () => {
    expect(migration).toContain('ALTER TABLE twitch_oauth_tokens ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.twitch_oauth_tokens TO service_role')
    expect(migration).toContain('FOR ALL')
    expect(migration).toContain('TO service_role')
    expect(migration).toContain('USING (true)')
    expect(migration).toContain('WITH CHECK (true)')
    expect(migration).not.toMatch(/FOR ALL\s+USING\s*\(true\)/i)
  })
})
