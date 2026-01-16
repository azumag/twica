import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Card, Streamer, GachaHistory } from "@/types/database";

interface CardWithDetails extends Card {
  streamer: Streamer;
  count: number;
}

interface GachaHistoryWithCard extends GachaHistory {
  cards: Card;
}

export async function getStreamerData(twitchUserId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const { data: streamer } = await supabaseAdmin
    .from("streamers")
    .select("*")
    .eq("twitch_user_id", twitchUserId)
    .single();

  if (!streamer) return null;

  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("*")
    .eq("streamer_id", streamer.id)
    .order("created_at", { ascending: false });

  return { streamer, cards: cards || [] };
}

export async function getUserCards(twitchUserId: string): Promise<CardWithDetails[]> {
  const supabaseAdmin = getSupabaseAdmin();

  const { data: user } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("twitch_user_id", twitchUserId)
    .single();

  if (!user) return [];

  const { data: userCards } = await supabaseAdmin
    .from("user_cards")
    .select(`
      card_id,
      cards (
        *,
        streamers (*)
      )
    `)
    .eq("user_id", user.id);

  if (!userCards) return [];

  const cardMap = new Map<string, CardWithDetails>();

  for (const uc of userCards) {
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
}

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