import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { validateDropRateSum } from "@/lib/validations";
import { logger } from "@/lib/logger";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsPost, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "リクエストが多すぎます。しばらく待ってから再試行してください。" },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(rateLimitResult.limit),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(rateLimitResult.reset),
        },
      }
    );
  }

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { streamerId, name, description, imageUrl, rarity, dropRate } = body;

    if (typeof dropRate !== "number" || dropRate < 0 || dropRate > 1) {
      return NextResponse.json(
        { error: "Drop rate must be a number between 0 and 1" },
        { status: 400 }
      );
    }

    // Verify streamer owns this streamer profile
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Validate drop rate sum
    const dropRateValidation = await validateDropRateSum(
      supabaseAdmin,
      streamerId,
      dropRate
    );
    if (!dropRateValidation.valid) {
      return NextResponse.json(
        { error: dropRateValidation.error },
        { status: 400 }
      );
    }

    const { data: card, error } = await supabaseAdmin
      .from("cards")
      .insert({
        streamer_id: streamerId,
        name,
        description,
        image_url: imageUrl,
        rarity,
        drop_rate: dropRate,
      })
      .select()
      .single();

    if (error) {
      logger.error("Database error:", error);
      return NextResponse.json({ error: "Failed to create card" }, { status: 500 });
    }

    return NextResponse.json(card);
  } catch (error) {
    logger.error("Error creating card:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);
  const streamerId = searchParams.get("streamerId");

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "リクエストが多すぎます。しばらく待ってから再試行してください。" },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(rateLimitResult.limit),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(rateLimitResult.reset),
        },
      }
    );
  }

  if (!streamerId) {
    return NextResponse.json({ error: "Missing streamerId" }, { status: 400 });
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data: streamer, error: streamerError } = await supabaseAdmin
    .from("streamers")
    .select("id")
    .eq("id", streamerId)
    .eq("twitch_user_id", session?.twitchUserId)
    .single();

  if (streamerError || !streamer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: cards, error } = await supabaseAdmin
    .from("cards")
    .select("*")
    .eq("streamer_id", streamerId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error("Database error:", error);
    return NextResponse.json({ error: "Failed to fetch cards" }, { status: 500 });
  }

  return NextResponse.json(cards);
}
