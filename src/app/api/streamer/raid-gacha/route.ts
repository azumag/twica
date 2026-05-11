import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { logger } from "@/lib/logger";

const DEFAULT_ACTIVE_MINUTES = 30;
const MAX_ACTIVE_MINUTES = 180;

function isRaidStateSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204" || message.includes("raid_gacha_active_until");
}

function isActiveUntil(value: string | null | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function getOwnedStreamer(twitchUserId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  let { data: streamer, error } = await supabaseAdmin
    .from("streamers")
    .select("id, raid_gacha_active_until")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (isRaidStateSchemaError(error)) {
    const fallbackResult = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", twitchUserId)
      .maybeSingle();
    streamer = fallbackResult.data
      ? { ...fallbackResult.data, raid_gacha_active_until: null }
      : fallbackResult.data;
    error = fallbackResult.error;
  }

  return { streamer, error };
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimitResult.limit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(rateLimitResult.reset),
        },
      },
    );
  }

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const { streamer, error } = await getOwnedStreamer(session.twitchUserId);
    if (error) return handleDatabaseError(error, "Raid Gacha API: GET");
    if (!streamer) return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });

    return NextResponse.json({
      active: isActiveUntil(streamer.raid_gacha_active_until),
      activeUntil: streamer.raid_gacha_active_until,
    }, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    return handleApiError(error, "Raid Gacha API: GET");
  }
}

export async function POST(request: NextRequest) {
  const contentTypeValidation = validateContentType(request, "application/json");
  if (contentTypeValidation) return contentTypeValidation;

  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
  }

  const session = await getSession();
  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimitResult.limit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(rateLimitResult.reset),
        },
      },
    );
  }

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const body = await request.json();
    const active = body.active === true;
    const requestedMinutes = body.activeMinutes === undefined
      ? DEFAULT_ACTIVE_MINUTES
      : Number(body.activeMinutes);

    if (body.active !== undefined && typeof body.active !== "boolean") {
      return NextResponse.json({ error: "active must be a boolean" }, { status: 400 });
    }
    if (!Number.isInteger(requestedMinutes) || requestedMinutes < 1 || requestedMinutes > MAX_ACTIVE_MINUTES) {
      return NextResponse.json(
        { error: `activeMinutes must be an integer between 1 and ${MAX_ACTIVE_MINUTES}` },
        { status: 400 },
      );
    }

    const { streamer, error: streamerError } = await getOwnedStreamer(session.twitchUserId);
    if (streamerError) return handleDatabaseError(streamerError, "Raid Gacha API: POST lookup");
    if (!streamer) return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });

    const activeUntil = active
      ? new Date(Date.now() + requestedMinutes * 60 * 1000).toISOString()
      : null;

    const supabaseAdmin = getSupabaseAdmin();
    const { data: updatedStreamer, error } = await supabaseAdmin
      .from("streamers")
      .update({ raid_gacha_active_until: activeUntil })
      .eq("id", streamer.id)
      .select("raid_gacha_active_until")
      .maybeSingle();

    if (error) return handleDatabaseError(error, "Raid Gacha API: POST update");

    logger.info("Raid gacha state updated", {
      streamerId: streamer.id,
      active,
      activeUntil,
    });

    return NextResponse.json({
      success: true,
      active: isActiveUntil(updatedStreamer?.raid_gacha_active_until),
      activeUntil: updatedStreamer?.raid_gacha_active_until ?? null,
    });
  } catch (error) {
    return handleApiError(error, "Raid Gacha API: POST");
  }
}
