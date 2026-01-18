import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";

interface DeleteRequestBody {
  userId: string;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
    }

    const identifier = await getRateLimitIdentifier(request, session.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.gachaHistoryDelete, identifier);

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
        }
      );
    }

    const { id } = await params;
    const body = await request.json() as DeleteRequestBody;
    const { userId } = body;

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Verify the gacha history belongs to the user
    const { data: history, error: fetchError } = await supabaseAdmin
      .from("gacha_history")
      .select("user_twitch_id")
      .eq("id", id)
      .single();

    if (fetchError || !history) {
      return handleDatabaseError(fetchError, "Fetching gacha history for deletion");
    }

    if (history.user_twitch_id !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("gacha_history")
      .delete()
      .eq("id", id);

    if (error) {
      return handleDatabaseError(error, "Deleting gacha history");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Deleting gacha history");
  }
}