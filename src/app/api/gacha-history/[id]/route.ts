import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const supabaseAdmin = getSupabaseAdmin();

    const { data: history } = await supabaseAdmin
      .from("gacha_history")
      .select("streamer_id, streamers!inner(twitch_user_id)")
      .eq("id", id)
      .single();

    const streamers = history?.streamers as any;
    const twitchUserId = Array.isArray(streamers) ? streamers[0]?.twitch_user_id : streamers?.twitch_user_id;

    if (!history || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("gacha_history")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Database error:", error);
      return NextResponse.json({ error: "Failed to delete gacha history" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting gacha history:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}