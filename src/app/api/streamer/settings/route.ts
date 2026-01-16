import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const session = await getSession();

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("streamers")
      .update({
        channel_point_reward_id: channelPointRewardId,
        channel_point_reward_name: channelPointRewardName,
      })
      .eq("id", streamerId);

    if (error) {
      logger.error("Database error:", error);
      return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Error updating settings:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
