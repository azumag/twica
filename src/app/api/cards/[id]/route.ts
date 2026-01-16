import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { validateDropRateSum } from "@/lib/validations";
import { logger } from "@/lib/logger";

export async function PUT(
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
    const body = await request.json();
    const { name, description, imageUrl, rarity, dropRate } = body;

    if (typeof dropRate !== "number" || dropRate < 0 || dropRate > 1) {
      return NextResponse.json(
        { error: "Drop rate must be a number between 0 and 1" },
        { status: 400 }
      );
    }

    // Verify ownership
    const { data: card } = await supabaseAdmin
      .from("cards")
      .select("streamer_id, streamers!inner(twitch_user_id)")
      .eq("id", id)
      .single();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamers = card?.streamers as any;
    const twitchUserId = Array.isArray(streamers) ? streamers[0]?.twitch_user_id : streamers?.twitch_user_id;

    if (!card || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Validate drop rate sum
    const dropRateValidation = await validateDropRateSum(
      supabaseAdmin,
      card.streamer_id,
      dropRate,
      id
    );
    if (!dropRateValidation.valid) {
      return NextResponse.json(
        { error: dropRateValidation.error },
        { status: 400 }
      );
    }

    const { data: updatedCard, error } = await supabaseAdmin
      .from("cards")
      .update({
        name,
        description,
        image_url: imageUrl,
        rarity,
        drop_rate: dropRate,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      logger.error("Database error:", error);
      return NextResponse.json({ error: "Failed to update card" }, { status: 500 });
    }

    return NextResponse.json(updatedCard);
  } catch (error) {
    logger.error("Error updating card:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

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

    // Verify ownership
    const { data: card } = await supabaseAdmin
      .from("cards")
      .select("streamer_id, streamers!inner(twitch_user_id)")
      .eq("id", id)
      .single();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamers = card?.streamers as any;
    const twitchUserId = Array.isArray(streamers) ? streamers[0]?.twitch_user_id : streamers?.twitch_user_id;

    if (!card || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("cards")
      .delete()
      .eq("id", id);

    if (error) {
      logger.error("Database error:", error);
      return NextResponse.json({ error: "Failed to delete card" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Error deleting card:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
