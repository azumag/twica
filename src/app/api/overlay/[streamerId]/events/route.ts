import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { withRetry } from "@/lib/supabase/retry";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import {
  checkRateLimit,
  getRateLimitIdentifier,
  rateLimits,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import type { Rarity } from "@/types/database";
import type { ApiRateLimitResponse } from "@/types/api";

interface RouteParams {
  params: Promise<{ streamerId: string }>;
}

interface OverlayHistoryCard {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  rarity: Rarity;
}

interface OverlayHistoryRow {
  id: string;
  redeemed_at: string;
  user_twitch_username: string | null;
  cards: OverlayHistoryCard | OverlayHistoryCard[] | null;
}

function isValidDate(value: string | null): value is string {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function resolveCard(cards: OverlayHistoryRow["cards"]): OverlayHistoryCard | null {
  if (Array.isArray(cards)) {
    return cards[0] ?? null;
  }
  return cards;
}

/**
 * GET /api/overlay/[streamerId]/events
 *
 * Public polling fallback for OBS overlays. Realtime remains the primary path,
 * but this endpoint lets overlays recover when Supabase Realtime rejects public
 * channel joins or a browser source loses its WebSocket for a long period.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { streamerId } = await params;
    if (!streamerId) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_ID_REQUIRED },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const since = searchParams.get("since");
    if (!isValidDate(since)) {
      return NextResponse.json(
        { error: "Invalid since parameter" },
        { status: 400 }
      );
    }

    const identifier = await getRateLimitIdentifier(request);
    const rateLimitResult = await checkRateLimit(
      rateLimits.overlayEventsGet,
      identifier
    );

    if (!rateLimitResult.success) {
      return NextResponse.json<ApiRateLimitResponse>(
        {
          error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
          retryAfter:
            (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
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

    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await withRetry(
      () =>
        supabaseAdmin
          .from("gacha_history")
          .select(
            "id, redeemed_at, user_twitch_username, cards(id, name, description, image_url, rarity)"
          )
          .eq("streamer_id", streamerId)
          .gt("redeemed_at", since)
          .order("redeemed_at", { ascending: true })
          .limit(10),
      "overlayEvents",
      { maxRetries: 1 }
    );

    if (error) {
      return handleDatabaseError(error, "Overlay Events API");
    }

    const events = ((data ?? []) as OverlayHistoryRow[])
      .map((row) => {
        const card = resolveCard(row.cards);
        if (!card) return null;
        return {
          id: row.id,
          redeemedAt: row.redeemed_at,
          userTwitchUsername: row.user_twitch_username ?? "Unknown",
          card,
        };
      })
      .filter((event): event is NonNullable<typeof event> => event !== null);

    return NextResponse.json({ events });
  } catch (error) {
    return handleApiError(error, "Overlay Events API");
  }
}
