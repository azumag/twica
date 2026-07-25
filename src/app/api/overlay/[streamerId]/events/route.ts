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
import { resolveOverlayRealtimeConfigVersion } from "@/lib/overlay-realtime/resolve-config";
import { getOverlayDemoEvent } from "@/lib/overlay/demo-event-store";

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

  // PlanetScale/PostgreSQL returns timestamptz cursors with a signed offset
  // and microseconds (for example `...14.511943+00:00`). Parse that stable
  // wire shape explicitly instead of depending on Date.parse: the
  // Cloudflare/OpenNext runtime has rejected the signed-offset form even
  // though browsers commonly accept it. Once the first row advanced the OBS
  // cursor to that value, every later poll therefore returned HTTP 400 and no
  // subsequent gacha result could be displayed.
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-]| )(\d{2}):(\d{2}))$/
  );
  if (!match) return null;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = "",
    timezone,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  // PostgreSQL represents years before 1 CE with a separate BC suffix rather
  // than ISO year zero. This public cursor grammar intentionally excludes BC
  // and extended years so every accepted value remains a four-digit DB value.
  if (year < 1) return null;

  // Build at whole-second precision. JavaScript Date stores only
  // milliseconds, while PostgreSQL cursors use up to six fractional digits.
  // Keeping the fraction outside Date prevents truncating the authoritative
  // `(redeemed_at, id)` cursor and re-reading the same database row forever.
  // setUTCFullYear is used instead of Date.UTC so four-digit years below 100
  // are not implicitly remapped into 1900-1999.
  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, 0);

  // Date setters normalize invalid calendar values (for example February 30)
  // instead of rejecting them. Compare every component so a malformed public
  // cursor cannot silently move the polling window to another day.
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (timezone !== "Z") {
    const offsetHours = Number(offsetHourText);
    const offsetMinutePart = Number(offsetMinuteText);
    if (offsetHours > 23 || offsetMinutePart > 59) return null;
    // A literal plus in a query string can be normalized to a space by an
    // application/x-www-form-urlencoded parser before NextRequest exposes
    // the value. In the timezone-sign position only, treat that space as a
    // positive offset. The strict surrounding timestamp pattern prevents
    // accepting arbitrary whitespace or a malformed public cursor.
    offsetMinutes =
      (offsetSign === "-" ? -1 : 1) *
      (offsetHours * 60 + offsetMinutePart);
  }

  const utcDate = new Date(localDate.getTime() - offsetMinutes * 60_000);
  // A valid four-digit local year can cross into year 0 or 10000 after offset
  // conversion. Date#toISOString uses an extended signed-year representation
  // there, which is outside this endpoint's strict cursor grammar and would
  // make fixed-width canonicalization unsafe.
  const utcYear = utcDate.getUTCFullYear();
  if (utcYear < 1 || utcYear > 9999) return null;
  const utcWholeSecond = utcDate.toISOString().slice(0, 19);
  return `${utcWholeSecond}${fraction ? `.${fraction}` : ""}Z`;
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
    const demoSinceParam = searchParams.get("demoSince");
    const demoSince = demoSinceParam
      ? normalizeDateParam(demoSinceParam)
      : null;
    if (demoSinceParam && !demoSince) {
      return NextResponse.json(
        { error: "Invalid demoSince parameter" },
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

    // Start the optional KV read together with the PlanetScale query. Awaiting
    // them serially would add KV latency to every active overlay even though
    // the two stores and their cursors are independent.
    const demoEventPromise = demoSince
      ? getOverlayDemoEvent(streamerId, demoSince).catch(() => null)
      : Promise.resolve(null);

    let overlayHistoryRows: OverlayHistoryRow[];
    let demoEvent: Awaited<ReturnType<typeof getOverlayDemoEvent>>;
    try {
      [overlayHistoryRows, demoEvent] = await Promise.all([
        getOverlayHistoryRows(streamerId, since, afterId),
        demoEventPromise,
      ]);
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

    // Demo delivery is best-effort, unlike committed history. It shares this
    // response to eliminate the former always-on `/demo-events` request, but a
    // transient KV outage must never make PlanetScale gap recovery fail. The
    // independent demo cursor also prevents an operator test from advancing
    // the authoritative `(redeemed_at, history_id)` business cursor.
    // Advance by the last database row, including a defensive left-join miss.
    // Using the filtered display list could otherwise query the same tail row
    // forever and prevent later committed rows from being reached.
    const lastHistoryRow =
      overlayHistoryRows[overlayHistoryRows.length - 1] ?? null;
    // Never expose the database driver's signed-offset/microsecond wire value
    // as the next public cursor. A canonical UTC cursor avoids query-string
    // plus-sign ambiguity on every later OBS poll even if an intermediary
    // applies form-decoding semantics. The row already passed through the
    // same database timestamp contract used by the query predicate, so a
    // normalization failure indicates a server-side invariant violation.
    const normalizedNextCursor = lastHistoryRow
      ? normalizeDateParam(lastHistoryRow.redeemed_at)
      : null;
    if (lastHistoryRow && !normalizedNextCursor) {
      throw new Error("Invalid redeemed_at value returned by the database");
    }

    return NextResponse.json({
      // Existing OBS pages retain the legacy row shape. New controllers opt
      // into V1 to avoid returning duplicate card payloads during rollout.
      ...(wantsRealtimeV1
        ? { realtimeEvents: buildPollingRealtimeEvents(streamerId, events) }
        : { events }),
      nextCursor: lastHistoryRow
        ? {
            redeemedAt: normalizedNextCursor,
            historyId: lastHistoryRow.id,
          }
        : null,
      ...(demoSince ? { demoEvent } : {}),
      overlayVersion: process.env.NEXT_PUBLIC_OVERLAY_VERSION ?? "dev",
      // Rollout/rollback signal carried on a request the overlay already makes.
      //
      // Every overlay polls this endpoint: every ~3s in polling-only mode and
      // every ~30s as gap recovery while the socket is healthy. Echoing the
      // effective config version here lets the client drop its separate
      // 30-second config poll, which was roughly half of all overlay traffic,
      // without weakening the kill switch: an operator flipping the allowlist
      // is now noticed on the next pass the client was making anyway (faster in
      // polling-only mode, unchanged while DO-connected).
      //
      // Computed through the shared resolver so this value can never disagree
      // with what the config endpoint would return.
      realtimeConfigVersion: resolveOverlayRealtimeConfigVersion(streamerId),
    });
  } catch (error) {
    return handleApiError(error, "Overlay Events API");
  }
}
