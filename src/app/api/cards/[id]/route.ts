import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { validateDropRateSum } from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { extractTwitchUserId } from "@/types/database";
import { ERROR_MESSAGES } from "@/lib/constants";
import type { ApiRateLimitResponse } from "@/types/api";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsId, identifier);

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

  const { id } = await params;

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { name, description, imageUrl, rarity, dropRate } = body;

    if (typeof dropRate !== "number" || dropRate < 0 || dropRate > 1) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.DROP_RATE_INVALID },
        { status: 400 }
      );
    }

    // Verify ownership
    const { data: card } = await supabaseAdmin
      .from("cards")
      .select("streamer_id, streamers!inner(twitch_user_id)")
      .eq("id", id)
      .single();

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Validate drop rate sum
    const dropRateValidation = await validateDropRateSum(
      supabaseAdmin,
      card.streamer_id,
      dropRate,
      id
    );
    if (!dropRateValidation.valid) {
      return NextResponse.json(
        { error: dropRateValidation.error },
        { status: 400 }
      );
    }

    const { data: updatedCard, error } = await supabaseAdmin
      .from("cards")
      .update({
        name,
        description,
        image_url: imageUrl,
        rarity,
        drop_rate: dropRate,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return handleDatabaseError(error, "Failed to update card");
    }

    return NextResponse.json(updatedCard);
  } catch (error) {
    return handleApiError(error, "Cards API: PUT");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsId, identifier);

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

  const { id } = await params;

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // Verify ownership
    const { data: card } = await supabaseAdmin
      .from("cards")
      .select("streamer_id, streamers!inner(twitch_user_id)")
      .eq("id", id)
      .single();

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("cards")
      .delete()
      .eq("id", id);

    if (error) {
      return handleDatabaseError(error, "Failed to delete card");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Cards API: DELETE");
  }
}
