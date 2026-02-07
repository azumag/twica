import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { normalizeDropRate } from "@/lib/card-utils";
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
    .maybeSingle();

  if (!streamer) return null;

  // Extract and sort cards (newest first)
  // カードを抽出してソート（新しい順）
  const cards = normalizeDropRate(streamer.cards || [])
    .sort((a, b) =>
      new Date((b as Record<string, unknown>).created_at as string).getTime() - new Date((a as Record<string, unknown>).created_at as string).getTime()
    ) as Card[];

  // Return without the nested cards to match expected interface
  // 期待されるインターフェースに合わせてネストされたcardsを除外して返す
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { cards: _cardsNested, ...streamerData } = streamer;
  return { streamer: streamerData, cards };
})

/**
 * Get streamer data with paginated cards
 * サーバーサイドページング対応の配信者データとカード取得
 */
export const getStreamerDataPaginated = cache(async (
  twitchUserId: string,
  page: number = 1,
  perPage: number = 8
) => {
  const supabaseAdmin = getSupabaseAdmin();
  const start = Date.now();

  // Get streamer first
  // まず配信者を取得
  const { data: streamer } = await supabaseAdmin
    .from("streamers")
    .select("*")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (!streamer) return null;

  // Get total count of cards for this streamer
  // この配信者のカード総数を取得
  const { count: totalCount } = await supabaseAdmin
    .from("cards")
    .select("*", { count: "exact", head: true })
    .eq("streamer_id", streamer.id);

  // Get paginated cards with ordering
  // ページネーション付きでカードを取得（新しい順）
  const offset = (page - 1) * perPage;
  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("*")
    .eq("streamer_id", streamer.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + perPage - 1);

  logger.info(`[Perf] getStreamerDataPaginated: ${Date.now() - start}ms (page ${page}, ${cards?.length || 0} cards)`);

  return {
    streamer,
    cards: cards || [],
    pagination: {
      page,
      perPage,
      total: totalCount || 0,
      totalPages: Math.ceil((totalCount || 0) / perPage),
    },
  };
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
    .maybeSingle();
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

/**
 * Internal function to fetch user cards for a specific streamer from database
 * 内部関数: 特定の配信者のユーザーカードをデータベースから取得
 */
async function fetchUserCardsForStreamerFromDB(
  twitchUserId: string,
  streamerId: string
): Promise<CardWithDetails[]> {
  const startTotal = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  // Get user with their cards for the specific streamer
  // 特定の配信者のカードのみを取得
  const startQuery = Date.now();
  const { data: user } = await supabaseAdmin
    .from("users")
    .select(`
      id,
      user_cards (
        card_id,
        cards!inner (
          *,
          streamers!inner (*)
        )
      )
    `)
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();
  logger.info(`[Perf] getUserCardsForStreamer query: ${Date.now() - startQuery}ms`);

  if (!user || !user.user_cards) {
    logger.info(`[Perf] getUserCardsForStreamer total (no data): ${Date.now() - startTotal}ms`);
    return [];
  }

  const cardMap = new Map<string, CardWithDetails>();

  for (const uc of user.user_cards) {
    const card = uc.cards as unknown as Card & { streamers: Streamer };
    if (!card) continue;

    // Filter by streamer ID
    // 配信者IDでフィルタリング
    if (card.streamers.id !== streamerId) continue;

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

  logger.info(`[Perf] getUserCardsForStreamer total: ${Date.now() - startTotal}ms`);
  return Array.from(cardMap.values());
}

/**
 * Get user's card collection for a specific streamer - cached with Next.js cache (30 seconds TTL)
 * 特定の配信者のユーザーカードコレクション取得 - Next.jsキャッシュ使用（30秒TTL）
 */
export const getUserCardsForStreamer = cache(async (
  twitchUserId: string,
  streamerId: string
): Promise<CardWithDetails[]> => {
  const start = Date.now();

  // Use Next.js cache with 30 second revalidation
  // Next.jsキャッシュを使用（30秒で再検証）
  const cachedFetch = unstable_cache(
    async () => fetchUserCardsForStreamerFromDB(twitchUserId, streamerId),
    [`user-cards-${twitchUserId}-${streamerId}`],
    { revalidate: 30, tags: [`user-cards-${twitchUserId}-${streamerId}`] }
  );

  const result = await cachedFetch();
  logger.info(`[Perf] getUserCardsForStreamer (with cache): ${Date.now() - start}ms`);
  return result;
});

/**
 * Get streamer info by ID
 * 配信者IDから配信者情報を取得
 */
export const getStreamerById = cache(async (streamerId: string): Promise<Streamer | null> => {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: streamer } = await supabaseAdmin
    .from("streamers")
    .select("*")
    .eq("id", streamerId)
    .maybeSingle();

  return streamer;
});

/**
 * Get a specific user's card with details
 * Returns the card with count (how many the user owns) if the user owns it, null otherwise
 * 特定のユーザーのカード情報を詳細付きで取得
 * ユーザーが所有している場合はカウント（所有枚数）付きで返し、所有していない場合はnullを返す
 */
export const getUserCardDetail = cache(async (
  twitchUserId: string,
  streamerId: string,
  cardId: string
): Promise<CardWithDetails | null> => {
  const start = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  // Get the card with streamer info to verify it belongs to the streamer
  // カードと配信者情報を取得して、配信者のものかどうかを確認
  const { data: card } = await supabaseAdmin
    .from("cards")
    .select(`
      *,
      streamers (*)
    `)
    .eq("id", cardId)
    .eq("streamer_id", streamerId)
    .maybeSingle();

  if (!card) {
    logger.info(`[Perf] getUserCardDetail (card not found): ${Date.now() - start}ms`);
    return null;
  }

  // Get user's ownership count for this card
  // このカードのユーザー所有枚数を取得
  const { data: user } = await supabaseAdmin
    .from("users")
    .select(`
      id,
      user_cards!inner (
        card_id
      )
    `)
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  // Count how many of this specific card the user owns
  // ユーザーがこの特定のカードを何枚所有しているかをカウント
  const count = user?.user_cards?.filter(
    (uc: { card_id: string }) => uc.card_id === cardId
  ).length || 0;

  // If user doesn't own this card, return null
  // ユーザーがこのカードを所有していない場合はnullを返す
  if (count === 0) {
    logger.info(`[Perf] getUserCardDetail (user doesn't own card): ${Date.now() - start}ms`);
    return null;
  }

  logger.info(`[Perf] getUserCardDetail: ${Date.now() - start}ms`);

  const cardWithStreamer = card as unknown as Card & { streamers: Streamer };
  return {
    ...cardWithStreamer,
    streamer: cardWithStreamer.streamers,
    count,
  };
});
