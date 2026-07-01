import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { isMissingCardPackNamesColumnError } from "@/lib/collections/collection-existence";
import type { ApiRateLimitResponse } from "@/types/api";

/**
 * GET /api/cards/collections?streamerId=...
 *
 * Issue #393再設計: 事前登録されたカードパック名一覧を返す(streamers.card_pack_names)。
 * アクティブカードの有無は問わない — パック管理モーダルで定義した時点で選択肢に
 * 含まれる(空パックへの紐付けは保存時に checkCollectionHasActiveCards が別途弾く)。
 *
 * Response: { collections: string[] } (定義順、NULL/重複なし)。
 *
 * 旧実装(DISTINCT な有効カード collection_name を返す)から変更。呼び出し元
 * (ChannelPointSettings)のインターフェースは変更なし。
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);
  const streamerId = searchParams.get("streamerId");

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      {
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  if (!streamerId) {
    return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_ID_MISSING }, { status: 400 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // Verify the session owns this streamer profile, and read the pre-defined
    // pack list in the same query.
    const { data: streamer, error: streamerError } = await supabaseAdmin
      .from("streamers")
      .select("id, card_pack_names")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (streamerError) {
      // Deploy-window fallback: column not migrated yet → no packs exist.
      if (isMissingCardPackNamesColumnError(streamerError)) {
        const { data: ownedStreamer } = await supabaseAdmin
          .from("streamers")
          .select("id")
          .eq("id", streamerId)
          .eq("twitch_user_id", session.twitchUserId)
          .maybeSingle();
        if (!ownedStreamer) {
          return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
        }
        return NextResponse.json({ collections: [] });
      }
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const collections = Array.isArray(streamer.card_pack_names)
      ? (streamer.card_pack_names as string[])
      : [];

    return NextResponse.json({ collections });
  } catch (error) {
    return handleApiError(error, "Cards Collections API: GET");
  }
}
