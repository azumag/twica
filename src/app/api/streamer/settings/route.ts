import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";

export async function POST(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
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
    const { streamerId, channelPointRewardId, channelPointRewardName } = body;

    // Verify ownership
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("streamers")
      .update({
        channel_point_reward_id: channelPointRewardId,
        channel_point_reward_name: channelPointRewardName,
      })
      .eq("id", streamerId);

    if (error) {
      return handleDatabaseError(error, "Streamer Settings API: PUT");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Streamer Settings API: General");
  }
}
