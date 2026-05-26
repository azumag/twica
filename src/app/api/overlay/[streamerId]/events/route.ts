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
  event_id: string | null;
  redeemed_at: string;
  user_twitch_username: string | null;
  cards: OverlayHistoryCard | OverlayHistoryCard[] | null;
}

function normalizeDateParam(value: string | null): string | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  // Cloudflare/OBS combinations can send Postgres timestamps with
  // microseconds (6 fractional digits), which some runtimes reject.
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) return null;

  const [, base, fraction = "", timezone] = match;
  const normalizedFraction = fraction.padEnd(3, "0").slice(0, 3);
  const normalized = `${base}.${normalizedFraction}${timezone}`;
  const normalizedTimestamp = Date.parse(normalized);
  return Number.isFinite(normalizedTimestamp)
    ? new Date(normalizedTimestamp).toISOString()
    : null;
}

function resolveCard(cards: OverlayHistoryRow["cards"]): OverlayHistoryCard | null {
  if (Array.isArray(cards)) {
    return cards[0] ?? null;
  }
  return cards;
}

const MAX_BATCH_IDS = 25;

function parseHistoryIdsParam(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_BATCH_IDS);
}

function mapHistoryRows(rows: OverlayHistoryRow[]) {
  return rows
    .map((row) => {
      const card = resolveCard(row.cards);
      if (!card) return null;
      return {
        id: row.id,
        eventId: row.event_id,
        redeemedAt: row.redeemed_at,
        userTwitchUsername: row.user_twitch_username ?? "Unknown",
        card,
      };
    })
    .filter((event): event is NonNullable<typeof event> => event !== null);
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
    const requestedIds = parseHistoryIdsParam(searchParams.get("ids"));

    if (requestedIds.length > 0) {
      const uniqueRequestedIds = Array.from(new Set(requestedIds));
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
              "id, event_id, redeemed_at, user_twitch_username, cards(id, name, description, image_url, rarity)"
            )
            .eq("streamer_id", streamerId)
            .in("id", uniqueRequestedIds),
        "overlayEventsByIds",
        { maxRetries: 1 }
      );

      if (error) {
        return handleDatabaseError(error, "Overlay Events API");
      }

      const eventsById = new Map(mapHistoryRows((data ?? []) as OverlayHistoryRow[]).map((event) => [event.id, event]));
      const events = requestedIds
        .map((id) => eventsById.get(id))
        .filter((event): event is NonNullable<typeof event> => event !== undefined);
      const complete = events.length === requestedIds.length;

      // ID指定はRealtime受信直後の詳細補完に使う。DB反映レースで欠けた応答を
      // キャッシュすると、全OBSソースが同じ欠落を踏むため完全一致時だけ短TTLにする。
      // Only complete batches are cacheable; partial batches must be retried by clients.
      return NextResponse.json(
        { events, complete },
        {
          headers: {
            "Cache-Control": complete
              ? "public, max-age=5, stale-while-revalidate=10"
              : "no-store",
          },
        }
      );
    }

    const since = normalizeDateParam(searchParams.get("since"));
    if (!since) {
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
            "id, event_id, redeemed_at, user_twitch_username, cards(id, name, description, image_url, rarity)"
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

    const events = mapHistoryRows((data ?? []) as OverlayHistoryRow[]);

    return NextResponse.json({ events });
  } catch (error) {
    return handleApiError(error, "Overlay Events API");
  }
}
