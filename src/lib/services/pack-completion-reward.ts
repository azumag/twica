import 'server-only';
import { getMaintenanceState } from '@/lib/maintenance/state';
import { unstable_cache } from 'next/cache';
import { getDb } from '@/lib/db/client';
import { logger } from '@/lib/logger.server';
import { resolvePendingRewardGrants, type CompletionRewardView } from '@/lib/pack-completion-reward';
import type { Card, PackCompletionRewardGrant } from '@/types/database';

export interface RewardWithCard {
  collection_name: string;
  reward_card_id: string;
  card: Card;
}
export const rewardCacheTag = (streamerId: string) => `pack-completion-rewards-${streamerId}`;

export async function getPackCompletionRewards(streamerId: string): Promise<RewardWithCard[]> {
  try {
    return await unstable_cache(async () => {
      const { sql } = await getDb();
      return await sql<RewardWithCard[]>`
        SELECT r.collection_name, r.reward_card_id, to_jsonb(c) AS card
        FROM public.pack_completion_rewards r JOIN public.cards c ON c.id = r.reward_card_id
        WHERE r.streamer_id = ${streamerId}::uuid ORDER BY r.collection_name`;
    }, [rewardCacheTag(streamerId)], { revalidate: 30, tags: [rewardCacheTag(streamerId)] })();
  } catch {
    logger.warn('Completion reward settings unavailable; continuing collection display');
    return [];
  }
}
export async function getPackCompletionRewardGrants(twitchUserId: string, streamerId: string): Promise<PackCompletionRewardGrant[]> {
  try {
    // Do not cache personal grant history: another tab may just have awarded it.
    const { sql } = await getDb();
    return await sql<PackCompletionRewardGrant[]>`SELECT * FROM public.pack_completion_reward_grants
      WHERE twitch_user_id = ${twitchUserId} AND streamer_id = ${streamerId}::uuid`;
  } catch {
    logger.warn('Completion reward history unavailable; continuing collection display');
    return [];
  }
}

/** Current ownership of historical bonus cards, not the current configured
 * card, is authoritative after replacement/trading/consumption. Fresh counts
 * also repair the pre-award 30-second user-card cache without revalidateTag
 * during Server Component rendering (which Next.js does not allow). */
export async function applyPackCompletionRewards(
  twitchUserId: string, streamerId: string, activeCards: Card[], ownedCards: (Card & { count: number })[],
): Promise<{ views: CompletionRewardView[]; cards: (Card & { count: number })[]; rewardCardIds: string[] }> {
  const fallback = { views: [] as CompletionRewardView[], cards: ownedCards, rewardCardIds: [] as string[] };
  try {
    const rewards = await getPackCompletionRewards(streamerId);
    // Grant history is authoritative for the badge even after a setting is
    // removed and its old reward card is re-enabled. Only an empty ownership
    // list can safely skip that personal history lookup when no setting exists.
    if (!rewards.length && !ownedCards.length) return fallback;
    let grants = await getPackCompletionRewardGrants(twitchUserId, streamerId);
    const newlyGranted = new Set<string>();
    const { sql } = await getDb();
    for (const reward of (getMaintenanceState().mode === 'off' ? resolvePendingRewardGrants(rewards, grants, activeCards, ownedCards) : [])) {
      try {
        const [row] = await sql<{ result: { granted: boolean } }[]>`
          SELECT public.grant_pack_completion_reward(${twitchUserId}, ${streamerId}::uuid,
            ${reward.collection_name}, ${reward.reward_card_id}::uuid) AS result`;
        if (row?.result.granted) newlyGranted.add(reward.collection_name);
      } catch {
        logger.warn('Completion reward grant failed; continuing collection display');
      }
    }
    if (rewards.length) grants = await getPackCompletionRewardGrants(twitchUserId, streamerId);
    if (!grants.length) return {
      ...fallback,
      views: rewards.map(r => ({ collectionName: r.collection_name, state: 'locked', rarity: r.card.rarity })),
    };
    const ids = [...new Set(grants.map(g => g.reward_card_id))];
    const historicalCards = await sql<{ card: Card; count: number }[]>`
      SELECT to_jsonb(c) AS card, count(uc.id)::integer AS count FROM public.cards c
      LEFT JOIN public.user_cards uc ON uc.card_id = c.id AND uc.user_id =
        (SELECT id FROM public.users WHERE twitch_user_id = ${twitchUserId})
      WHERE c.streamer_id = ${streamerId}::uuid AND c.id = ANY(${ids}::uuid[])
      GROUP BY c.id`;
    const cardMap = new Map(historicalCards.map(row => [row.card.id, row]));
    const grantMap = new Map(grants.map(g => [g.collection_name, g]));
    const views: CompletionRewardView[] = rewards.flatMap((r): CompletionRewardView[] => {
      const grant = grantMap.get(r.collection_name);
      if (!grant) return [{ collectionName: r.collection_name, state: 'locked', rarity: r.card.rarity }];
      const historical = cardMap.get(grant.reward_card_id);
      // Deleted definitions have no artwork left to reveal; never substitute a
      // newly configured secret card for the historical award.
      if (!historical) return [];
      return [{ collectionName: r.collection_name, state: newlyGranted.has(r.collection_name) ? 'grantedNow' : 'granted', card: historical.card }];
    });
    return {
      views, rewardCardIds: ids,
      cards: [...ownedCards.filter(c => !ids.includes(c.id)), ...historicalCards.filter(r => r.count > 0).map(r => ({ ...r.card, count: r.count }))],
    };
  } catch {
    logger.warn('Completion rewards unavailable; continuing collection display');
    return fallback;
  }
}
