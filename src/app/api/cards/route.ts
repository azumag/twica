import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { validateDropRateSum } from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import type { ApiRateLimitResponse } from "@/types/api";

export async function POST(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsPost, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      { 
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000)
      },
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
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { streamerId, name, description, imageUrl, rarity, dropRate } = body;

    if (typeof dropRate !== "number" || dropRate < 0 || dropRate > 1) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.DROP_RATE_INVALID },
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
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
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
      return handleDatabaseError(error, "Cards API: Failed to create card");
    }

    return NextResponse.json(card);
  } catch (error) {
    return handleApiError(error, "Cards API: POST");
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);
  const streamerId = searchParams.get("streamerId");

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      { 
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000)
      },
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
    return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_ID_MISSING }, { status: 400 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data: streamer, error: streamerError } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("id", streamerId)
      .eq("twitch_user_id", session?.twitchUserId)
      .single();

    if (streamerError || !streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const { data: cards, error } = await supabaseAdmin
      .from("cards")
      .select("id, streamer_id, name, description, image_url, rarity, drop_rate, created_at, updated_at")
      .eq("streamer_id", streamerId)
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      return handleDatabaseError(error, "Cards API: Failed to fetch cards");
    }

    return NextResponse.json(cards);
  } catch (error) {
    return handleApiError(error, "Cards API: GET");
  }
}
