import { logger } from "@/lib/logger";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

/**
 * Twitch emote data structure from API response
 * Twitch APIレスポンスのエモートデータ構造
 */
interface TwitchEmote {
  id: string;
  name: string;
  images: {
    url_1x: string;
    url_2x: string;
    url_4x: string;
  };
  tier: string;
  emote_type: string;
  emote_set_id: string;
  format: string[];
  scale: string[];
  theme_mode: string[];
}

/**
 * Transformed emote data for client use
 * クライアント用に変換されたエモートデータ
 */
export interface TransformedEmote {
  id: string;
  name: string;
  imageUrl: string;
  tier: string;
  emoteType: string;
}

/**
 * Twitch reward data structure
 * Twitch報酬データ構造
 */
export interface TwitchReward {
  id: string;
  broadcaster_id: string;
  broadcaster_login: string;
  broadcaster_name: string;
  title: string;
  prompt: string;
  cost: number;
  is_enabled: boolean;
  background_color: string;
  is_user_input_required: boolean;
  is_max_per_stream_enabled: boolean;
  max_per_stream: number;
  is_max_per_user_per_stream_enabled: boolean;
  max_per_user_per_stream: number;
  is_global_cooldown_enabled: boolean;
  global_cooldown_seconds: number;
  is_paused: boolean;
  is_in_stock: boolean;
  default_image: {
    url_1x: string;
    url_2x: string;
    url_4x: string;
  } | null;
  image: {
    url_1x: string;
    url_2x: string;
    url_4x: string;
  } | null;
}

// Cache TTL settings (in milliseconds)
// キャッシュTTL設定（ミリ秒単位）
const EMOTES_CACHE_TTL_MS = 300 * 1000; // 5 minutes - エモートは頻繁に変わらない
const REWARDS_CACHE_TTL_MS = 60 * 1000; // 1 minute - 報酬は変更される可能性がある

/**
 * In-memory cache entry structure
 * インメモリキャッシュエントリの構造
 */
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

// In-memory caches with automatic TTL expiration
// TTLで自動期限切れするインメモリキャッシュ
// Note: Using in-memory cache instead of unstable_cache because:
// 1. accessToken changes require fresh API calls (unstable_cache doesn't track closure variables)
// 2. In-memory cache provides predictable behavior within each serverless instance
// 注意: unstable_cacheの代わりにインメモリキャッシュを使用する理由:
// 1. accessTokenの変更には新しいAPI呼び出しが必要（unstable_cacheはクロージャ変数を追跡しない）
// 2. インメモリキャッシュは各サーバーレスインスタンス内で予測可能な動作を提供
const emotesCache = new Map<string, CacheEntry<TransformedEmote[]>>();
const rewardsCache = new Map<string, CacheEntry<TwitchReward[]>>();

// Periodic cleanup of expired cache entries (every 5 minutes)
// 期限切れキャッシュエントリの定期クリーンアップ（5分ごと）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of emotesCache.entries()) {
    if (now > entry.expiresAt) {
      emotesCache.delete(key);
    }
  }
  for (const [key, entry] of rewardsCache.entries()) {
    if (now > entry.expiresAt) {
      rewardsCache.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Internal function to fetch emotes from Twitch API
 * Twitch APIからエモートを取得する内部関数
 */
async function fetchEmotesFromTwitch(
  twitchUserId: string,
  accessToken: string
): Promise<TransformedEmote[]> {
  const start = Date.now();

  const response = await fetch(
    `${TWITCH_API_URL}/chat/emotes?broadcaster_id=${twitchUserId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": process.env.TWITCH_CLIENT_ID!,
      },
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Twitch API error: ${JSON.stringify(error)}`);
  }

  const data = await response.json();
  const emotes: TwitchEmote[] = data.data || [];

  // Transform emotes to a simpler format for the client
  // クライアント用にエモートをシンプルな形式に変換
  const transformedEmotes = emotes.map((emote) => ({
    id: emote.id,
    name: emote.name,
    imageUrl: emote.images.url_4x || emote.images.url_2x || emote.images.url_1x,
    tier: emote.tier,
    emoteType: emote.emote_type,
  }));

  logger.info(
    `[Perf] fetchEmotesFromTwitch: ${Date.now() - start}ms (${transformedEmotes.length} emotes)`
  );

  return transformedEmotes;
}

/**
 * Internal function to fetch rewards from Twitch API
 * Twitch APIから報酬を取得する内部関数
 */
async function fetchRewardsFromTwitch(
  twitchUserId: string,
  accessToken: string
): Promise<TwitchReward[]> {
  const start = Date.now();

  const response = await fetch(
    `${TWITCH_API_URL}/channel_points/custom_rewards?broadcaster_id=${twitchUserId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": process.env.TWITCH_CLIENT_ID!,
      },
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Twitch API error: ${JSON.stringify(error)}`);
  }

  const data = await response.json();
  const rewards: TwitchReward[] = data.data || [];

  logger.info(
    `[Perf] fetchRewardsFromTwitch: ${Date.now() - start}ms (${rewards.length} rewards)`
  );

  return rewards;
}

/**
 * Get cached emotes for a broadcaster
 * Uses in-memory cache with 5 minute TTL
 *
 * 配信者のキャッシュ済みエモートを取得
 * 5分TTLのインメモリキャッシュを使用
 */
export async function getCachedEmotes(
  twitchUserId: string,
  accessToken: string
): Promise<TransformedEmote[]> {
  const cacheKey = twitchUserId;
  const now = Date.now();
  const cached = emotesCache.get(cacheKey);

  // Return cached data if valid
  // 有効なキャッシュデータがあれば返す
  if (cached && now < cached.expiresAt) {
    logger.info(`[Cache] Emotes cache hit for user ${twitchUserId}`);
    return cached.data;
  }

  // Fetch fresh data from Twitch API
  // Twitch APIから新しいデータを取得
  const emotes = await fetchEmotesFromTwitch(twitchUserId, accessToken);

  // Store in cache with TTL
  // TTL付きでキャッシュに保存
  emotesCache.set(cacheKey, {
    data: emotes,
    expiresAt: now + EMOTES_CACHE_TTL_MS,
  });

  return emotes;
}

/**
 * Get cached rewards for a broadcaster
 * Uses in-memory cache with 1 minute TTL
 *
 * 配信者のキャッシュ済み報酬を取得
 * 1分TTLのインメモリキャッシュを使用
 */
export async function getCachedRewards(
  twitchUserId: string,
  accessToken: string
): Promise<TwitchReward[]> {
  const cacheKey = twitchUserId;
  const now = Date.now();
  const cached = rewardsCache.get(cacheKey);

  // Return cached data if valid
  // 有効なキャッシュデータがあれば返す
  if (cached && now < cached.expiresAt) {
    logger.info(`[Cache] Rewards cache hit for user ${twitchUserId}`);
    return cached.data;
  }

  // Fetch fresh data from Twitch API
  // Twitch APIから新しいデータを取得
  const rewards = await fetchRewardsFromTwitch(twitchUserId, accessToken);

  // Store in cache with TTL
  // TTL付きでキャッシュに保存
  rewardsCache.set(cacheKey, {
    data: rewards,
    expiresAt: now + REWARDS_CACHE_TTL_MS,
  });

  return rewards;
}
