import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import type { Card, Streamer, GachaHistory } from "@/types/database";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

interface GachaHistoryWithCard extends GachaHistory {
  cards: Card;
}

/**
 * Get streamer data with cards - cached per request
 * Single query using Supabase relations to reduce network round-trips
 *
 * リクエストごとにキャッシュされる配信者データとカードの取得
 * Supabaseのリレーションを使用して1回のクエリで取得し、ネットワーク往復を削減
 */
export const getStreamerData = cache(async (twitchUserId: string) => {
  const supabaseAdmin = getSupabaseAdmin();

  // Single query: get streamer with their cards using foreign key relation
  // 1回のクエリ: 外部キーリレーションを使用して配信者とカードを取得
  const { data: streamer } = await supabaseAdmin
    .from("streamers")
    .select(`
      *,
      cards (*)
    `)
    .eq("twitch_user_id", twitchUserId)
    .single();

  if (!streamer) return null;

  // Extract and sort cards (newest first)
  // カードを抽出してソート（新しい順）
  const cards = (streamer.cards || []).sort((a: { created_at: string }, b: { created_at: string }) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );

  // Return without the nested cards to match expected interface
  // 期待されるインターフェースに合わせてネストされたcardsを除外して返す
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { cards: _cardsNested, ...streamerData } = streamer;
  return { streamer: streamerData, cards };
})

/**
 * Internal function to fetch user cards from database
 * 内部関数: データベースからユーザーカードを取得
 */
async function fetchUserCardsFromDB(twitchUserId: string): Promise<CardWithDetails[]> {
  const startTotal = Date.now();

  const startClient = Date.now();
  const supabaseAdmin = getSupabaseAdmin();
  logger.info(`[Perf] getSupabaseAdmin: ${Date.now() - startClient}ms`);

  // Single query: get user with their cards using foreign key relations
  // 1回のクエリ: 外部キーリレーションを使用してユーザーとカードを取得
  const startQuery = Date.now();
  const { data: user } = await supabaseAdmin
    .from("users")
    .select(`
      id,
      user_cards (
        card_id,
        cards (
          *,
          streamers (*)
        )
      )
    `)
    .eq("twitch_user_id", twitchUserId)
    .single();
  logger.info(`[Perf] getUserCards query: ${Date.now() - startQuery}ms`);

  if (!user || !user.user_cards) {
    logger.info(`[Perf] getUserCards total (no data): ${Date.now() - startTotal}ms`);
    return [];
  }

  const cardMap = new Map<string, CardWithDetails>();

  for (const uc of user.user_cards) {
    const card = uc.cards as unknown as Card & { streamers: Streamer };
    if (!card) continue;

    const existing = cardMap.get(card.id);
    if (existing) {
      existing.count++;
    } else {
      cardMap.set(card.id, {
        ...card,
        streamer: card.streamers,
        count: 1,
      });
    }
  }

  logger.info(`[Perf] getUserCards total: ${Date.now() - startTotal}ms`);
  return Array.from(cardMap.values());
}

/**
 * Get user's card collection - cached with Next.js cache (30 seconds TTL)
 * Uses unstable_cache for cross-request caching to reduce database load
 *
 * ユーザーのカードコレクション取得 - Next.jsキャッシュ使用（30秒TTL）
 * unstable_cacheでリクエスト間キャッシュを使用してデータベース負荷を軽減
 */
export const getUserCards = cache(async (twitchUserId: string): Promise<CardWithDetails[]> => {
  const start = Date.now();

  // Use Next.js cache with 30 second revalidation
  // Next.jsキャッシュを使用（30秒で再検証）
  const cachedFetch = unstable_cache(
    async () => fetchUserCardsFromDB(twitchUserId),
    [`user-cards-${twitchUserId}`],
    { revalidate: 30, tags: [`user-cards-${twitchUserId}`] }
  );

  const result = await cachedFetch();
  logger.info(`[Perf] getUserCards (with cache): ${Date.now() - start}ms`);
  return result;
})

export async function getRecentGachaHistory(): Promise<GachaHistoryWithCard[]> {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: history } = await supabaseAdmin
    .from("gacha_history")
    .select(`
      *,
      cards (*)
    `)
    .order("redeemed_at", { ascending: false })
    .limit(10);

  return (history || []) as unknown as GachaHistoryWithCard[];
}
