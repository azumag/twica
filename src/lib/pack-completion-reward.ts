import { computePackProgress } from '@/lib/collection-packs';
import type { Card } from '@/types/database';

export interface CompletionRewardSetting {
  collection_name: string;
  reward_card_id: string;
}
export type CompletionRewardView = {
  collectionName: string;
  state: 'locked';
  rarity: string;
} | {
  collectionName: string;
  state: 'granted' | 'grantedNow';
  card: Card;
};

/** Reward cards are outside the collectible set: neither owning nor missing
 * an inactive bonus may affect completion. Start from settings, not UI tabs,
 * so a streamer using only the default pack can still award their bonus. */
export function resolvePendingRewardGrants<T extends CompletionRewardSetting>(
  rewards: T[],
  grants: { collection_name: string }[],
  cards: { id: string; collection_name: string | null; is_active: boolean | null }[],
  ownedCards: { id: string }[],
): T[] {
  const granted = new Set(grants.map(g => g.collection_name));
  const active = cards.filter(card => card.is_active === true);
  return rewards.filter(reward => {
    if (granted.has(reward.collection_name)) return false;
    const { owned, total } = computePackProgress(ownedCards, active, reward.collection_name);
    return total > 0 && owned === total;
  });
}
