import { cache } from "react";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
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
 * Get user's card collection - cached per request
 * Single query using Supabase relations to reduce network round-trips
 *
 * リクエストごとにキャッシュされるユーザーのカードコレクション取得
 * Supabaseのリレーションを使用して1回のクエリで取得し、ネットワーク往復を削減
 */
export const getUserCards = cache(async (twitchUserId: string): Promise<CardWithDetails[]> => {
  const supabaseAdmin = getSupabaseAdmin();

  // Single query: get user with their cards using foreign key relations
  // 1回のクエリ: 外部キーリレーションを使用してユーザーとカードを取得
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

  if (!user || !user.user_cards) return [];

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

  return Array.from(cardMap.values());
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
