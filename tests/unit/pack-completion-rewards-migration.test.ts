import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const path = 'db/planetscale/migrations/20260907000000_add_pack_completion_rewards.sql';
describe('completion reward database contract', () => {
  it('ships atomic grants, explicit privileges and a protected inactive reward', () => {
    expect(existsSync(path)).toBe(true);
    const sql = readFileSync(path, 'utf8');
    for (const text of ['ON CONFLICT (twitch_user_id, streamer_id, collection_name) DO NOTHING',
      'GRANT SELECT, INSERT, UPDATE, DELETE', 'TO service_role', 'BEFORE UPDATE',
      'FOR UPDATE', 'pack_rarity_weights', 'NOT EXISTS', 'INSERT INTO public.user_cards', 'c.is_active IS TRUE']) {
      expect(sql).toContain(text);
    }
  });
});
