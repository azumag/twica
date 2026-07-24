import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import {
  checkRateLimit,
  getRateLimitIdentifier,
  rateLimits,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import type { Rarity } from "@/types/database";
import type { ApiRateLimitResponse } from "@/types/api";
import { getDb } from "@/lib/db/client";
import { withDbRetry } from "@/lib/db/retry";
import {
  gachaHistory as gachaHistoryTable,
  cards as cardsTable,
} from "@/lib/db/schema";
import {
  buildPollingRealtimeEvents,
  isValidStreamerId,
} from "@/lib/overlay-realtime/contract";

// A redemption produces at most 15 rows. The larger bounded page keeps one
// batch together and gives gap recovery headroom without an unbounded query.
const OVERLAY_EVENT_ROW_LIMIT = 100;
const HISTORY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  reward_id: string | null;
  card: OverlayHistoryCard | null;
}

function normalizeDateParam(value: string | null): string | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  // Some OBS/Cloudflare combinations send PostgreSQL microseconds, while
  // JavaScript date parsers commonly accept only milliseconds.
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) return null;

  const [, base, fraction = "", timezone] = match;
  const normalized = `${base}.${fraction.padEnd(3, "0").slice(0, 3)}${timezone}`;
  const normalizedTimestamp = Date.parse(normalized);
  return Number.isFinite(normalizedTimestamp)
    ? new Date(normalizedTimestamp).toISOString()
    : null;
}

/**
 * Read the authoritative PlanetScale history in stable `(redeemed_at, id)`
 * order. The ID tie-breaker is required because all rows in a multi-draw can
 * share one timestamp; advancing by time alone would skip a split page.
 */
async function getOverlayHistoryRows(
  streamerId: string,
  since: string,
  afterId: string | null
): Promise<OverlayHistoryRow[]> {
  return withDbRetry(
    async () => {
      // getDb belongs inside the retry callback so connection acquisition and
      // the idempotent SELECT share the same bounded retry policy.
      const { db } = await getDb();
      const rows = await db
        .select({
          id: gachaHistoryTable.id,
          event_id: gachaHistoryTable.event_id,
          redeemed_at: gachaHistoryTable.redeemed_at,
          user_twitch_username: gachaHistoryTable.user_twitch_username,
          reward_id: gachaHistoryTable.reward_id,
          card_id: cardsTable.id,
          card_name: cardsTable.name,
          card_description: cardsTable.description,
          card_image_url: cardsTable.image_url,
          card_rarity: cardsTable.rarity,
        })
        .from(gachaHistoryTable)
        .leftJoin(cardsTable, eq(gachaHistoryTable.card_id, cardsTable.id))
        .where(
          and(
            eq(gachaHistoryTable.streamer_id, streamerId),
            afterId
              ? or(
                  gt(gachaHistoryTable.redeemed_at, since),
                  and(
                    eq(gachaHistoryTable.redeemed_at, since),
                    gt(gachaHistoryTable.id, afterId)
                  )
                )
              : gt(gachaHistoryTable.redeemed_at, since)
          )
        )
        .orderBy(
          asc(gachaHistoryTable.redeemed_at),
          asc(gachaHistoryTable.id)
        )
        .limit(OVERLAY_EVENT_ROW_LIMIT);

      return rows.map((row) => ({
        id: row.id,
        event_id: row.event_id,
        // The SQL `gt(redeemed_at, since)` predicate excludes NULL. Drizzle
        // retains schema nullability in the result type, so narrow the proven
        // query invariant at this single conversion boundary.
        redeemed_at: row.redeemed_at as string,
        user_twitch_username: row.user_twitch_username,
        reward_id: row.reward_id,
        card:
          row.card_id === null
            ? null
            : {
                id: row.card_id,
                name: row.card_name as string,
                description: row.card_description,
                image_url: row.card_image_url,
                rarity: row.card_rarity as Rarity,
              },
      }));
    },
    "overlayEvents",
    // This endpoint polls every three seconds. One retry covers brief database
    // failures without allowing a large request backlog during an outage.
    { idempotent: true, maxRetries: 1 }
  );
}

/**
 * Public gap-recovery transport for OBS overlays.
 *
 * Durable Objects WebSockets provide the primary low-latency delivery path;
 * this endpoint always reads committed PlanetScale history so reconnects and
 * the polling-only kill switch cannot lose a draw.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { streamerId } = await params;
    if (!isValidStreamerId(streamerId)) {
      return NextResponse.json(
        { error: "Invalid streamer ID" },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const since = normalizeDateParam(searchParams.get("since"));
    if (!since) {
      return NextResponse.json(
        { error: "Invalid since parameter" },
        { status: 400 }
      );
    }

    const afterIdParam = searchParams.get("afterId");
    const afterId =
      afterIdParam && HISTORY_ID_PATTERN.test(afterIdParam) ? afterIdParam : null;
    if (afterIdParam && !afterId) {
      return NextResponse.json(
        { error: "Invalid afterId parameter" },
        { status: 400 }
      );
    }
    const wantsRealtimeV1 = searchParams.get("contract") === "v1";

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

    let overlayHistoryRows: OverlayHistoryRow[];
    try {
      overlayHistoryRows = await getOverlayHistoryRows(
        streamerId,
        since,
        afterId
      );
    } catch (error) {
      return handleDatabaseError(error, "Overlay Events API");
    }

    const events = overlayHistoryRows
      .map((row) => {
        if (!row.card) return null;
        return {
          id: row.id,
          eventId: row.event_id,
          redeemedAt: row.redeemed_at,
          userTwitchUsername: row.user_twitch_username ?? "Unknown",
          rewardId: row.reward_id,
          card: row.card,
        };
      })
      .filter((event): event is NonNullable<typeof event> => event !== null);

    // Advance by the last database row, including a defensive left-join miss.
    // Using the filtered display list could otherwise query the same tail row
    // forever and prevent later committed rows from being reached.
    const lastHistoryRow =
      overlayHistoryRows[overlayHistoryRows.length - 1] ?? null;
    return NextResponse.json({
      // Existing OBS pages retain the legacy row shape. New controllers opt
      // into V1 to avoid returning duplicate card payloads during rollout.
      ...(wantsRealtimeV1
        ? { realtimeEvents: buildPollingRealtimeEvents(streamerId, events) }
        : { events }),
      nextCursor: lastHistoryRow
        ? {
            redeemedAt: lastHistoryRow.redeemed_at,
            historyId: lastHistoryRow.id,
          }
        : null,
      overlayVersion: process.env.NEXT_PUBLIC_OVERLAY_VERSION ?? "dev",
    });
  } catch (error) {
    return handleApiError(error, "Overlay Events API");
  }
}
