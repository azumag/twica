import { describe, expect, it } from 'vitest';
import { resolvePendingRewardGrants } from '@/lib/pack-completion-reward';

const rewards = [{ collection_name: '__default__', reward_card_id: 'bonus' }];
const normal = { id: 'normal', collection_name: null, is_active: true };
const bonus = { id: 'bonus', collection_name: null, is_active: false };
describe('completion rewards never require themselves', () => {
  it('grants on the default pack without owning the special card', () => {
    expect(resolvePendingRewardGrants(rewards, [], [normal, bonus], [normal])).toEqual(rewards);
  });
  it('does not change progress eligibility after owning the special card', () => {
    expect(resolvePendingRewardGrants(rewards, [], [normal, bonus], [normal, bonus])).toEqual(rewards);
  });
  it('cannot use only the special card to complete a pack', () => {
    expect(resolvePendingRewardGrants(rewards, [], [normal, bonus], [bonus])).toEqual([]);
  });
  it('does not complete an empty active pool', () => {
    expect(resolvePendingRewardGrants(rewards, [], [bonus], [bonus])).toEqual([]);
  });
  it('does not grant again after reward replacement', () => {
    expect(resolvePendingRewardGrants(rewards, [{ collection_name: '__default__' }], [normal], [normal])).toEqual([]);
  });
  it('requires newly added active types too', () => {
    expect(resolvePendingRewardGrants(rewards, [], [normal, { ...normal, id: 'new' }], [normal])).toEqual([]);
  });
  it('uses the configured named pack independently of the visible tabs', () => {
    const named = [{ collection_name: 'A', reward_card_id: 'bonus' }];
    expect(resolvePendingRewardGrants(named, [], [{ ...normal, collection_name: 'A' }, bonus], [normal])).toEqual(named);
  });
});
