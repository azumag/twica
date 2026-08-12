import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import {
  checkRateLimit,
  getRateLimitIdentifier,
  rateLimits,
  retryAfterSeconds,
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
import { isMissingCardPaddingColorError } from "@/lib/db/card-padding-color-errors";
import {
  buildPollingRealtimeEvents,
  isValidOverlayHistoryId,
  isValidStreamerId,
} from "@/lib/overlay-realtime/contract";
import { resolveOverlayRealtimeConfigVersion } from "@/lib/overlay-realtime/resolve-config";
import { getOverlayDemoEvent } from "@/lib/overlay/demo-event-store";
import { normalizeOverlayHistoryTimestamp } from "@/lib/overlay-history-cursor";

// A redemption produces at most 15 rows. The larger bounded page keeps one
// batch together and gives gap recovery headroom without an unbounded query.
const OVERLAY_EVENT_ROW_LIMIT = 100;

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
  // Fable厳格レビュー指摘(#899 PR #903)対応: image_padding_color を明示 select
  // に追加すると、当該列が migration 未適用の環境ではこのポーリングエンドポイント
  // (OBS のガチャ結果表示が依存する gap-recovery poll)が丸ごと失敗していた。
  // gacha.ts の loadPgCards と同じ「まず新列込みで試す→列欠落エラーなら列を
  // 落として再試行する」パターンで deploy-window の安全性を揃える。
  const loadRows = async (includePaddingColor: boolean) => {
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
        ...(includePaddingColor
          ? { card_image_padding_color: cardsTable.image_padding_color }
          : {}),
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
              image_padding_color:
                "card_image_padding_color" in row
                  ? row.card_image_padding_color
                  : null,
              rarity: row.card_rarity as Rarity,
            },
    }));
  };

  // This endpoint polls every three seconds. One retry covers brief database
  // failures without allowing a large request backlog during an outage.
  const retryOptions = { idempotent: true, maxRetries: 1 } as const;
  try {
    // getDb belongs inside the retry callback so connection acquisition and
    // the idempotent SELECT share the same bounded retry policy.
    return await withDbRetry(() => loadRows(true), "overlayEvents", retryOptions);
  } catch (error) {
    if (!isMissingCardPaddingColorError(error)) {
      throw error;
    }
    return withDbRetry(
      () => loadRows(false),
      "overlayEvents:padding-fallback",
      retryOptions
    );
  }
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
    const since = normalizeOverlayHistoryTimestamp(searchParams.get("since"));
    if (!since) {
      return NextResponse.json(
        { error: "Invalid since parameter" },
        { status: 400 }
      );
    }
    const demoSinceParam = searchParams.get("demoSince");
    const demoSince = demoSinceParam
      ? normalizeOverlayHistoryTimestamp(demoSinceParam)
      : null;
    if (demoSinceParam && !demoSince) {
      return NextResponse.json(
        { error: "Invalid demoSince parameter" },
        { status: 400 }
      );
    }

    const afterIdParam = searchParams.get("afterId");
    const afterId =
      afterIdParam && isValidOverlayHistoryId(afterIdParam) ? afterIdParam : null;
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
          retryAfter: retryAfterSeconds(rateLimitResult.reset),
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
      ? normalizeOverlayHistoryTimestamp(lastHistoryRow.redeemed_at)
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
      // Polling-only/disconnected overlays already call this endpoint, so they
      // can learn a transport change from the same response without a second
      // config request. A healthy DO connection performs history recovery only
      // at startup/reconnect or after a sequence gap; its room notice and the
      // infrequent reconciliation covers steady-state changes and gapless
      // post-commit publish failures.
      //
      // Computed through the shared resolver so this value can never disagree
      // with what the config endpoint would return.
      realtimeConfigVersion: resolveOverlayRealtimeConfigVersion(streamerId),
    });
  } catch (error) {
    return handleApiError(error, "Overlay Events API");
  }
}
