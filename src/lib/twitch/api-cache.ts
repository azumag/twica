import { unstable_cache } from "next/cache";
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

// Cache TTL settings (in seconds)
// キャッシュTTL設定（秒単位）
const EMOTES_CACHE_TTL = 300; // 5 minutes - エモートは頻繁に変わらない
const REWARDS_CACHE_TTL = 60; // 1 minute - 報酬は変更される可能性がある

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
 * Uses Next.js unstable_cache for cross-request caching (5 minute TTL)
 *
 * 配信者のキャッシュ済みエモートを取得
 * Next.jsのunstable_cacheでリクエスト間キャッシュを使用（5分TTL）
 */
export async function getCachedEmotes(
  twitchUserId: string,
  accessToken: string
): Promise<TransformedEmote[]> {
  // Create a cached version of the fetch function
  // フェッチ関数のキャッシュ版を作成
  const cachedFetch = unstable_cache(
    async () => fetchEmotesFromTwitch(twitchUserId, accessToken),
    [`twitch-emotes-${twitchUserId}`],
    {
      revalidate: EMOTES_CACHE_TTL,
      tags: [`twitch-emotes-${twitchUserId}`],
    }
  );

  return cachedFetch();
}

/**
 * Get cached rewards for a broadcaster
 * Uses Next.js unstable_cache for cross-request caching (1 minute TTL)
 *
 * 配信者のキャッシュ済み報酬を取得
 * Next.jsのunstable_cacheでリクエスト間キャッシュを使用（1分TTL）
 */
export async function getCachedRewards(
  twitchUserId: string,
  accessToken: string
): Promise<TwitchReward[]> {
  // Create a cached version of the fetch function
  // フェッチ関数のキャッシュ版を作成
  const cachedFetch = unstable_cache(
    async () => fetchRewardsFromTwitch(twitchUserId, accessToken),
    [`twitch-rewards-${twitchUserId}`],
    {
      revalidate: REWARDS_CACHE_TTL,
      tags: [`twitch-rewards-${twitchUserId}`],
    }
  );

  return cachedFetch();
}
