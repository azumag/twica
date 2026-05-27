import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('BOT account migration', () => {
  const migration = readFileSync(
    resolve(__dirname, '../../supabase/migrations/00040_add_bot_account_settings.sql'),
    'utf-8',
  )

  it('keeps BOT OAuth tokens out of streamers', () => {
    expect(migration).not.toMatch(/ALTER\s+TABLE\s+streamers[\s\S]*bot_.*token/i)
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS twitch_bot_accounts')
    expect(migration).toContain('twitch_access_token TEXT NOT NULL')
    expect(migration).toContain('twitch_refresh_token TEXT NOT NULL')
  })

  it('models custom and future official BOT senders explicitly', () => {
    expect(migration).toContain("owner_type TEXT NOT NULL CHECK (owner_type IN ('streamer', 'system'))")
    expect(migration).toContain("sender_mode TEXT NOT NULL DEFAULT 'streamer' CHECK (sender_mode IN ('streamer', 'custom_bot', 'official_bot'))")
    expect(migration).toContain('streamer_chat_sender_settings')
  })

  it('restricts BOT token tables to service role policies', () => {
    expect(migration).toContain('ALTER TABLE twitch_bot_accounts ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('ALTER TABLE streamer_chat_sender_settings ENABLE ROW LEVEL SECURITY')
    expect(migration).toMatch(/ON twitch_bot_accounts\s+FOR ALL\s+TO service_role/i)
    expect(migration).toMatch(/ON streamer_chat_sender_settings\s+FOR ALL\s+TO service_role/i)
    expect(migration).not.toMatch(/ON twitch_bot_accounts[\s\S]*TO authenticated/i)
  })
})
