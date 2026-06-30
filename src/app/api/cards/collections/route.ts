import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { isMissingCollectionNameColumn } from "@/lib/collections/collection-existence";
import type { ApiRateLimitResponse } from "@/types/api";

/**
 * GET /api/cards/collections?streamerId=...
 *
 * Issue #393: lightweight list of the streamer's distinct card pack names.
 * Returns only packs that contain at least one ACTIVE card, because gacha only
 * draws active cards — surfacing empty packs would let streamers bind a reward to
 * a pool that always fails at redemption time.
 *
 * Response: { collections: string[] } (DISTINCT, NULL excluded, sorted).
 *
 * This replaces the previous reliance on fetching the full /api/cards list and
 * picking names client-side (wrong response shape, heavy payload).
 *
 * 課題 #393: 配信者のカードパック名一覧(軽量)。is_active=true のカードを持つ
 * パックのみ返す(ガチャは active のみ抽選するため、空パックは出さない)。
 */
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
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimitResult.limit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(rateLimitResult.reset),
        },
      }
    );
  }

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  if (!streamerId) {
    return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_ID_MISSING }, { status: 400 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // Verify the session owns this streamer profile.
    const { data: streamer, error: streamerError } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (streamerError || !streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const { data: rows, error } = await supabaseAdmin
      .from("cards")
      .select("collection_name")
      .eq("streamer_id", streamerId)
      .eq("is_active", true)
      .not("collection_name", "is", null);

    if (error) {
      // Deploy-window fallback: column not migrated yet → no packs exist.
      if (isMissingCollectionNameColumn(error)) {
        return NextResponse.json({ collections: [] });
      }
      throw error;
    }

    // Deduplicate + sort. Names are already trimmed on write, but trim defensively.
    const collections = Array.from(
      new Set(
        (rows ?? [])
          .map((row) => (typeof row.collection_name === "string" ? row.collection_name.trim() : ""))
          .filter((name) => name.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ collections });
  } catch (error) {
    return handleApiError(error, "Cards Collections API: GET");
  }
}
