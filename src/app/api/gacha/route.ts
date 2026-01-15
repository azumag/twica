import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { selectWeightedCard } from "@/lib/gacha";

export async function POST(request: NextRequest) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { streamerId, userTwitchId, userTwitchUsername } = body;

    if (!streamerId || !userTwitchId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Get active cards for this streamer
    const { data: cards, error: cardsError } = await supabaseAdmin
      .from("cards")
      .select("id, drop_rate")
      .eq("streamer_id", streamerId)
      .eq("is_active", true);

    if (cardsError || !cards || cards.length === 0) {
      return NextResponse.json(
        { error: "No cards available" },
        { status: 404 }
      );
    }

    // Select a card based on drop rates
    const selectedCard = selectWeightedCard(cards);

    if (!selectedCard) {
      return NextResponse.json(
        { error: "Failed to select card" },
        { status: 500 }
      );
    }

    // Get full card data
    const { data: card, error: cardError } = await supabaseAdmin
      .from("cards")
      .select("*")
      .eq("id", selectedCard.id)
      .single();

    if (cardError || !card) {
      return NextResponse.json(
        { error: "Failed to fetch card" },
        { status: 500 }
      );
    }

    // Record gacha history
    await supabaseAdmin.from("gacha_history").insert({
      user_twitch_id: userTwitchId,
      user_twitch_username: userTwitchUsername,
      card_id: selectedCard.id,
      streamer_id: streamerId,
    });

    // Check if user exists, if so add to their collection
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("twitch_user_id", userTwitchId)
      .single();

    if (user) {
      await supabaseAdmin.from("user_cards").insert({
        user_id: user.id,
        card_id: selectedCard.id,
      });
    }

    return NextResponse.json({
      card,
      userTwitchUsername,
    });
  } catch (error) {
    console.error("Gacha error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
