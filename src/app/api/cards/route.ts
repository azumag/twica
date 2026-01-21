import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  validateCardName,
  validateCardDescription,
  validateImageUrl,
  validateRarity,
} from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import type { ApiRateLimitResponse } from "@/types/api";

export async function POST(request: NextRequest) {
  // Content-Type validation - must be the first check
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) {
    return contentTypeValidation
  }

  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsPost, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      { 
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000)
      },
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
    const { streamerId, name, description, imageUrl, rarity, dropRate } = body;

    const nameValidation = validateCardName(name)
    if (!nameValidation.valid) {
      return NextResponse.json(
        { error: nameValidation.error },
        { status: 400 }
      )
    }

    const descriptionValidation = validateCardDescription(description)
    if (!descriptionValidation.valid) {
      return NextResponse.json(
        { error: descriptionValidation.error },
        { status: 400 }
      )
    }

    const imageUrlValidation = validateImageUrl(imageUrl)
    if (!imageUrlValidation.valid) {
      return NextResponse.json(
        { error: imageUrlValidation.error },
        { status: 400 }
      )
    }

    const rarityValidation = validateRarity(rarity)
    if (!rarityValidation.valid) {
      return NextResponse.json(
        { error: rarityValidation.error },
        { status: 400 }
      )
    }

    if (typeof dropRate !== "number" || dropRate < 0 || dropRate > 1) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.DROP_RATE_INVALID },
        { status: 400 }
      );
    }

    // Verify streamer owns this streamer profile
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // NOTE: Drop rate validation removed because the system uses relative weights
    // The actual probability is calculated as: this_card_weight / total_weights
    // So there's no need to limit the sum to 100% - weights are relative, not absolute percentages
    // 注意: ドロップレート検証を削除。システムは相対重みを使用するため
    // 実際の確率は「このカードの重み / 全体の重み」で計算される
    // 重みは相対的であり絶対的な割合ではないため、合計100%制限は不要

    const { data: card, error } = await supabaseAdmin
      .from("cards")
      .insert({
        streamer_id: streamerId,
        name,
        description,
        image_url: imageUrl,
        rarity,
        drop_rate: dropRate,
      })
      .select()
      .single();

    if (error) {
      return handleDatabaseError(error, "Cards API: Failed to create card");
    }

    return NextResponse.json(card);
  } catch (error) {
    return handleApiError(error, "Cards API: POST");
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);
  const streamerId = searchParams.get("streamerId");
  // Pagination parameters
  // ページネーションパラメータ
  const limit = Math.min(parseInt(searchParams.get("limit") || "12", 10), 50);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  // Include inactive cards (for card management)
  // 非アクティブカードも含める（カード管理用）
  const includeInactive = searchParams.get("includeInactive") === "true";

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      {
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000)
      },
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

  if (!streamerId) {
    return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_ID_MISSING }, { status: 400 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data: streamer, error: streamerError } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("id", streamerId)
      .eq("twitch_user_id", session?.twitchUserId)
      .single();

    if (streamerError || !streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Single query with count and pagination
    // カウントとページネーションを1クエリで取得
    let query = supabaseAdmin
      .from("cards")
      .select("*", { count: "exact" })
      .eq("streamer_id", streamerId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    // Only filter by is_active if not including inactive
    // includeInactiveでない場合のみis_activeでフィルタ
    if (!includeInactive) {
      query = query.eq("is_active", true);
    }

    const { data: cards, error, count } = await query;

    if (error) {
      return handleDatabaseError(error, "Cards API: Failed to fetch cards");
    }

    // Return paginated response with metadata
    // メタデータ付きのページネーションレスポンスを返す
    return NextResponse.json({
      cards: cards || [],
      pagination: {
        total: count || 0,
        limit,
        offset,
        hasMore: (count || 0) > offset + limit,
      },
    });
  } catch (error) {
    return handleApiError(error, "Cards API: GET");
  }
}
