import { it, expect } from 'vitest';
import { getRewardCardProtectionPack } from '@/lib/pack-completion-reward-errors';
it('reads the dedicated SQLSTATE through Drizzle without treating absent schema as protection', () => {
  expect(getRewardCardProtectionPack({ cause: { code: 'P0720', detail: 'A' } })).toBe('A');
  expect(getRewardCardProtectionPack({ code: '42P01', message: 'pack_completion_rewards missing' })).toBeNull();
});
