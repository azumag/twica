import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { normalizeDropRate } from "@/lib/card-utils";
import { reportError } from "@/lib/sentry/error-handler";
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
  // Supabaseのリレーション型はdrop_rateがunknownになるため、Card[]にキャストしてから正規化
  const cards = normalizeDropRate((streamer.cards || []) as Card[])
    .sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

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
 * Gacha history filter options for streamer queries
 * 配信者向けガチャ履歴フィルタオプション
 */
interface GachaHistoryFilters {
  page?: number;
  perPage?: number;
  username?: string;
  rarity?: string;
  cardId?: string;
  userId?: string;
  from?: string;
  to?: string;
}

/**
 * Paginated gacha history result
 * ページネーション付きガチャ履歴結果
 */
interface PaginatedGachaHistory {
  history: GachaHistoryWithCard[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Get gacha history for a streamer with pagination and filters
 * Supports filtering by username, rarity, and date range
 * 配信者向け: ページネーション・フィルタ付きガチャ履歴取得
 * ユーザー名、レアリティ、期間でのフィルタリングをサポート
 */
export async function getGachaHistoryForStreamer(
  streamerId: string,
  filters: GachaHistoryFilters = {}
): Promise<PaginatedGachaHistory> {
  const { page = 1, perPage = 20, username, rarity, cardId, userId, from, to } = filters;
  const supabaseAdmin = getSupabaseAdmin();

  // Use !inner join when filtering by rarity to ensure correct count
  // レアリティフィルタ時は !inner JOINで正確なcountを保証
  const joinType = rarity ? "cards!inner(*)" : "cards(*)";
  let query = supabaseAdmin
    .from("gacha_history")
    .select(`*, ${joinType}`, { count: "exact" })
    .eq("streamer_id", streamerId);

  // Apply filters / フィルタを適用
  if (username) {
    // Escape LIKE pattern characters to prevent unintended matching
    // LIKEパターン文字をエスケープして意図しないマッチを防止
    const escaped = username.replace(/%/g, "\\%").replace(/_/g, "\\_");
    query = query.ilike("user_twitch_username", `%${escaped}%`);
  }
  if (rarity) {
    query = query.eq("cards.rarity", rarity);
  }
  if (cardId) {
    query = query.eq("card_id", cardId);
  }
  if (userId) {
    query = query.eq("user_twitch_id", userId);
  }
  if (from) {
    query = query.gte("redeemed_at", from);
  }
  if (to) {
    // Use "less than next day" instead of "less than or equal to end-of-day"
    // to cleanly include the entire "to" date
    // Note: dates are interpreted in UTC. For non-UTC users, boundary dates
    // may shift by a few hours. This is acceptable for approximate date filtering.
    // 「次の日未満」を使用して "to" 日付全体を含める
    // 注: 日付はUTCで解釈される。非UTCユーザーでは境界日が数時間ずれる可能性があるが、
    // 大まかな日付フィルタとしては許容範囲。
    const nextDay = new Date(`${to}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    query = query.lt("redeemed_at", nextDay.toISOString());
  }

  // Apply pagination and ordering
  // ページネーションと並び順を適用
  const offset = (page - 1) * perPage;
  query = query
    .order("redeemed_at", { ascending: false })
    .range(offset, offset + perPage - 1);

  const { data, count } = await query;
  const total = count || 0;

  return {
    history: (data || []) as unknown as GachaHistoryWithCard[],
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}

/**
 * Get gacha history for a specific user with pagination
 * 視聴者向け: ページネーション付きの自分のガチャ履歴取得
 */
export async function getGachaHistoryForUser(
  userTwitchId: string,
  filters: { page?: number; perPage?: number } = {}
): Promise<PaginatedGachaHistory> {
  const { page = 1, perPage = 20 } = filters;
  const supabaseAdmin = getSupabaseAdmin();

  const offset = (page - 1) * perPage;
  // Join streamers to show which channel the gacha was drawn on
  // どのチャネルでガチャを引いたかを表示するため streamers を JOIN
  const { data, count } = await supabaseAdmin
    .from("gacha_history")
    .select("*, cards(*), streamers(twitch_display_name)", { count: "exact" })
    .eq("user_twitch_id", userTwitchId)
    .order("redeemed_at", { ascending: false })
    .range(offset, offset + perPage - 1);

  const total = count || 0;

  return {
    history: (data || []) as unknown as GachaHistoryWithCard[],
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}

/**
 * Gacha user entry for the users tab
 * ユーザータブ用のガチャユーザー情報
 */
export interface GachaUserEntry {
  userTwitchId: string;
  username: string;
  drawCount: number;
  uniqueCards: number;
  /** Active cards the user has drawn at least once (unique by card ID) */
  uniqueCardIds: string[];
  lastDrawAt: string;
}

/**
 * Get aggregated user list for a streamer's gacha history
 * JS側で集約: ユニークユーザー一覧、各ユーザーのユニークカード数、ガチャ回数、最終日時
 * 配信者向け: ガチャを引いたユーザー一覧を集約して返す
 */
export async function getGachaUsersForStreamer(
  streamerId: string,
  options: { page?: number; perPage?: number } = {}
): Promise<{ users: GachaUserEntry[]; pagination: { page: number; perPage: number; total: number; totalPages: number } }> {
  const { page = 1, perPage = 20 } = options;
  const supabaseAdmin = getSupabaseAdmin();

  // Fetch gacha history and active card IDs in parallel
  // ガチャ履歴とアクティブカードIDを並列取得
  // Note: 10,000件上限は getGachaStats と同じパターン。
  // 超過する配信者では集計が近似値となる。
  const [historyResult, activeCardsResult] = await Promise.all([
    supabaseAdmin
      .from("gacha_history")
      .select("user_twitch_id, user_twitch_username, card_id, redeemed_at")
      .eq("streamer_id", streamerId)
      .order("redeemed_at", { ascending: false })
      .limit(10000),
    supabaseAdmin
      .from("cards")
      .select("id")
      .eq("streamer_id", streamerId)
      .eq("is_active", true),
  ]);

  const data = historyResult.data;
  if (!data || data.length === 0) {
    return {
      users: [],
      pagination: { page, perPage, total: 0, totalPages: 0 },
    };
  }

  // Build active card ID set for filtering uniqueCards
  // uniqueCards のフィルタリング用にアクティブカードIDセットを構築
  const activeCardIds = new Set((activeCardsResult.data || []).map((c) => c.id));

  // Aggregate by user / ユーザーごとに集約
  const userMap = new Map<string, {
    username: string;
    drawCount: number;
    cardIds: Set<string>;
    lastDrawAt: string;
  }>();

  for (const row of data) {
    const existing = userMap.get(row.user_twitch_id);
    if (existing) {
      existing.drawCount++;
      // Only count active cards for collection progress
      // コレクション進捗にはアクティブカードのみカウント
      if (activeCardIds.has(row.card_id)) {
        existing.cardIds.add(row.card_id);
      }
    } else {
      const cardIds = new Set<string>();
      if (activeCardIds.has(row.card_id)) {
        cardIds.add(row.card_id);
      }
      userMap.set(row.user_twitch_id, {
        username: row.user_twitch_username || "",
        drawCount: 1,
        cardIds,
        lastDrawAt: row.redeemed_at,
      });
    }
  }

  // Convert to sorted array (by draw count descending)
  // ガチャ回数の降順でソート
  const allUsers: GachaUserEntry[] = Array.from(userMap.entries())
    .map(([userTwitchId, info]) => ({
      userTwitchId,
      username: info.username,
      drawCount: info.drawCount,
      uniqueCards: info.cardIds.size,
      uniqueCardIds: Array.from(info.cardIds),
      lastDrawAt: info.lastDrawAt,
    }))
    .sort((a, b) => b.drawCount - a.drawCount);

  // Client-side pagination / クライアント側ページネーション
  const total = allUsers.length;
  const offset = (page - 1) * perPage;
  const paginatedUsers = allUsers.slice(offset, offset + perPage);

  return {
    users: paginatedUsers,
    pagination: {
      page,
      perPage,
      total,
      totalPages: Math.ceil(total / perPage),
    },
  };
}

/**
 * Gacha statistics result for a streamer
 * 配信者向けガチャ統計結果
 */
export interface GachaStatsResult {
  totalDraws: number;
  cardStats: Array<{
    cardId: string;
    cardName: string;
    rarity: string;
    imageUrl: string | null;
    configuredRate: number;
    actualCount: number;
    actualRate: number;
  }>;
  rarityStats: Array<{
    rarity: string;
    count: number;
    rate: number;
  }>;
}

/**
 * Get gacha statistics for a streamer within a given period
 * Query gacha_history filtered by streamer_id and date range,
 * then compare actual draw counts against configured drop_rate
 * 配信者向け: 指定期間のガチャ統計を取得
 * streamer_idと期間でガチャ履歴をフィルタし、
 * 実際の排出回数と設定された排出率を比較
 */
export async function getGachaStats(
  streamerId: string,
  period: "7d" | "30d"
): Promise<GachaStatsResult> {
  const supabaseAdmin = getSupabaseAdmin();
  const now = new Date();
  const daysAgo = period === "7d" ? 7 : 30;
  const fromDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);

  // Run all 3 independent queries in parallel to reduce latency
  // 3つの独立したクエリを並列実行してレイテンシを削減
  const [countResult, historyResult, cardsResult] = await Promise.all([
    // 1. Get total draw count using count-only query (avoids 1000-row limit)
    // count-onlyクエリで正確な総ガチャ回数を取得（1000行制限を回避）
    supabaseAdmin
      .from("gacha_history")
      .select("id", { count: "exact", head: true })
      .eq("streamer_id", streamerId)
      .gte("redeemed_at", fromDate.toISOString()),
    // 2. Fetch history with card_id to count draws per card
    // card_idのみ取得してカードごとの排出回数を集計
    // For very active streamers (>10000 draws/period), counts may be approximate.
    // 非常にアクティブな配信者（期間内10000回超）の場合、カウントは近似値になる可能性がある。
    supabaseAdmin
      .from("gacha_history")
      .select("card_id, cards(rarity)")
      .eq("streamer_id", streamerId)
      .gte("redeemed_at", fromDate.toISOString())
      .limit(10000),
    // 3. Fetch all active cards to include cards with 0 draws
    // 排出0回のカードも含めるため、配信者の全アクティブカードを取得
    supabaseAdmin
      .from("cards")
      .select("id, name, rarity, image_url, drop_rate")
      .eq("streamer_id", streamerId)
      .eq("is_active", true),
  ]);

  const totalDraws = countResult.count;
  const history = historyResult.data;
  const allCards = cardsResult.data;

  const safeTotal = totalDraws || 0;

  // Count draws per card
  // カードごとの排出回数を集計
  const drawCounts = new Map<string, number>();
  for (const h of history || []) {
    drawCounts.set(h.card_id, (drawCounts.get(h.card_id) || 0) + 1);
  }

  // Calculate total configured weight for percentage calculation
  // パーセンテージ計算用に設定重みの合計を算出
  const totalWeight = (allCards || []).reduce(
    (sum, c) => sum + (c.drop_rate || 0),
    0
  );

  // Build per-card stats
  // カードごとの統計を構築
  const cardStats = (allCards || []).map((card) => {
    const actualCount = drawCounts.get(card.id) || 0;
    return {
      cardId: card.id,
      cardName: card.name,
      rarity: card.rarity,
      imageUrl: card.image_url,
      // Configured rate as percentage of total weight
      // 全体の重みに対する設定率（パーセンテージ）
      configuredRate: totalWeight > 0 ? (card.drop_rate / totalWeight) * 100 : 0,
      actualCount,
      actualRate: safeTotal > 0 ? (actualCount / safeTotal) * 100 : 0,
    };
  });

  // Build rarity-level stats
  // レアリティレベルの統計を構築
  const rarityMap = new Map<string, number>();
  for (const h of history || []) {
    const card = h.cards as unknown as { rarity: string } | null;
    if (card) {
      rarityMap.set(card.rarity, (rarityMap.get(card.rarity) || 0) + 1);
    }
  }

  const rarityStats = ["legendary", "epic", "rare", "common"].map(
    (rarity) => {
      const count = rarityMap.get(rarity) || 0;
      return {
        rarity,
        count,
        rate: safeTotal > 0 ? (count / safeTotal) * 100 : 0,
      };
    }
  );

  return { totalDraws: safeTotal, cardStats, rarityStats };
}

/**
 * Internal function to fetch active cards for a specific streamer from database
 * 内部関数: 特定配信者のアクティブカードをデータベースから取得
 */
async function fetchActiveCardsForStreamerFromDB(streamerId: string): Promise<Card[]> {
  const startTotal = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  const startQuery = Date.now();
  // Use generated column rarity_order for stable rarity sorting
  // generated columnのrarity_orderを使用してレアリティ順で安定ソート
  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("*")
    .eq("streamer_id", streamerId)
    .eq("is_active", true)
    .order("rarity_order", { ascending: true })
    .order("created_at", { ascending: false });
  logger.info(`[Perf] getActiveCardsForStreamer query: ${Date.now() - startQuery}ms`);

  logger.info(`[Perf] getActiveCardsForStreamer total: ${Date.now() - startTotal}ms`);
  return normalizeDropRate(cards || []);
}

/**
 * Get active cards for a specific streamer - cached with Next.js cache (30 seconds TTL)
 * 特定配信者のアクティブカード取得 - Next.jsキャッシュ使用（30秒TTL）
 */
export const getActiveCardsForStreamer = cache(async (
  streamerId: string
): Promise<Card[]> => {
  const start = Date.now();

  const cachedFetch = unstable_cache(
    async () => fetchActiveCardsForStreamerFromDB(streamerId),
    [`active-cards-${streamerId}`],
    { revalidate: 30, tags: [`active-cards-${streamerId}`] }
  );

  const result = await cachedFetch();
  logger.info(`[Perf] getActiveCardsForStreamer (with cache): ${Date.now() - start}ms`);
  return result;
});

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

/**
 * Record a collection completion achievement
 * UNIQUE制約により同一total_cardsでの重複挿入はスキップされる
 * Cloudflare Workers では void 呼び出しだと応答後に破棄されるため、
 * 呼び出し側で必ず await すること
 *
 * コレクションコンプリート達成をDBに記録する
 */
export async function recordCollectionCompletion(
  twitchUserId: string,
  streamerId: string,
  totalCards: number,
): Promise<void> {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    // upsert with ignoreDuplicates: UNIQUE制約違反時は静かにスキップ
    const { error } = await supabaseAdmin
      .from("collection_completions")
      .upsert(
        { twitch_user_id: twitchUserId, streamer_id: streamerId, total_cards: totalCards },
        { onConflict: "twitch_user_id,streamer_id,total_cards", ignoreDuplicates: true },
      );
    if (error) {
      logger.error(`Failed to record collection completion: ${error.message}`);
      reportError(error, { context: "recordCollectionCompletion", twitchUserId, streamerId, totalCards });
    }
  } catch (err) {
    // fire-and-forget: エラーでページ表示を壊さない
    logger.error(`Unexpected error in recordCollectionCompletion: ${err}`);
    reportError(err instanceof Error ? err : new Error(String(err)), {
      context: "recordCollectionCompletion", twitchUserId, streamerId, totalCards,
    });
  }
}

/**
 * Get past collection completion records for a user and streamer
 * Returns records sorted by completed_at DESC (newest first)
 *
 * ユーザー×配信者の過去コンプリート達成記録を取得（新しい順）
 */
export const getCollectionCompletions = cache(async (
  twitchUserId: string,
  streamerId: string,
): Promise<{ total_cards: number; completed_at: string }[]> => {
  const cachedFetch = unstable_cache(
    async () => {
      const supabaseAdmin = getSupabaseAdmin();
      const { data, error } = await supabaseAdmin
        .from("collection_completions")
        .select("total_cards, completed_at")
        .eq("twitch_user_id", twitchUserId)
        .eq("streamer_id", streamerId)
        .order("completed_at", { ascending: false });
      if (error) {
        logger.error(`Failed to fetch collection completions: ${error.message}`);
        return [];
      }
      return data || [];
    },
    [`collection-completions-${twitchUserId}-${streamerId}`],
    { revalidate: 30, tags: [`collection-completions-${twitchUserId}-${streamerId}`] },
  );

  return cachedFetch();
});
