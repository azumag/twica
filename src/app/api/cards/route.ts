import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  validateCardName,
  validateCardDescription,
  validateCardMediaType,
  validateCardMediaUrl,
  validateRarity,
} from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { normalizeDropRate } from "@/lib/card-utils";
import { getStorageUsage } from "@/lib/storage-usage";
import { sha256Prefix } from "@/lib/crypto-utils";
import { logger } from "@/lib/logger";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
import { CARD_NUMBER_MESSAGES, isCardNumberConflictError, isMissingCardNumberColumnError } from "@/lib/card-number-errors";
import { isMissingCardMediaTypeColumnError, normalizeCardMediaType } from "@/lib/card-media";
import { countVideoCardsForStreamer, getVideoCardLimit } from "@/lib/card-video-limits";
import { getUserPlan } from "@/lib/plan";
import type { ApiRateLimitResponse } from "@/types/api";

// Cache TTL for cards list (30 seconds to balance freshness and CPU usage)
// カード一覧のキャッシュTTL（新鮮さとCPU使用量のバランスで30秒）
const CARDS_CACHE_TTL = 30;

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
    // プランダウングレード等でストレージ超過中の場合、新規カード作成を拒否
    // 画像を含むカード作成時に、更なるストレージ消費を防止する
    const userPrefix = await sha256Prefix(session.twitchUserId);
    const storageUsage = await getStorageUsage(userPrefix, session.twitchUserId);
    if (storageUsage.planOverLimit) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.PLAN_OVER_LIMIT },
        { status: 507 }
      );
    }

    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { streamerId, name, description, imageUrl, mediaType, rarity, dropRate, intraRarityWeight, cardNumber } = body;
    const normalizedMediaType = normalizeCardMediaType(mediaType);

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

    const mediaTypeValidation = validateCardMediaType(mediaType)
    if (!mediaTypeValidation.valid) {
      return NextResponse.json(
        { error: mediaTypeValidation.error },
        { status: 400 }
      )
    }

    const mediaUrlValidation = validateCardMediaUrl(imageUrl, normalizedMediaType)
    if (!mediaUrlValidation.valid) {
      return NextResponse.json(
        { error: mediaUrlValidation.error },
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

    if (
      cardNumber !== undefined &&
      cardNumber !== null &&
      (!Number.isInteger(cardNumber) || cardNumber <= 0)
    ) {
      return NextResponse.json(
        { error: CARD_NUMBER_MESSAGES.invalid },
        { status: 400 }
      );
    }

    // intraRarityWeight は省略可能（デフォルト1.0）。指定時は正の数値のみ
    if (intraRarityWeight !== undefined) {
      if (typeof intraRarityWeight !== "number" || !Number.isFinite(intraRarityWeight) || intraRarityWeight <= 0) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.INTRA_RARITY_WEIGHT_INVALID },
          { status: 400 }
        );
      }
    }

    // Verify streamer owns this streamer profile
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id, rarity_weights")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    if (normalizedMediaType === "video") {
      const plan = await getUserPlan(session.twitchUserId);
      const limit = getVideoCardLimit(plan);
      const currentVideoCards = await countVideoCardsForStreamer(supabaseAdmin, streamerId);
      if (currentVideoCards >= limit) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.VIDEO_CARD_LIMIT_EXCEEDED, limit, plan },
          { status: 403 }
        );
      }
    }

    // NOTE: Drop rate validation removed because the system uses relative weights
    // The actual probability is calculated as: this_card_weight / total_weights
    // So there's no need to limit the sum to 100% - weights are relative, not absolute percentages
    // 注意: ドロップレート検証を削除。システムは相対重みを使用するため
    // 実際の確率は「このカードの重み / 全体の重み」で計算される
    // 重みは相対的であり絶対的な割合ではないため、合計100%制限は不要

    const insertData: Record<string, unknown> = {
      streamer_id: streamerId,
      name,
      description,
      image_url: imageUrl,
      media_type: normalizedMediaType,
      rarity,
      card_number: cardNumber ?? null,
      drop_rate: dropRate,
    };
    if (intraRarityWeight !== undefined) {
      insertData.intra_rarity_weight = intraRarityWeight;
    }

    let { data: card, error } = await supabaseAdmin
      .from("cards")
      .insert(insertData)
      .select()
      .maybeSingle();

    if (error && isMissingCardNumberColumnError(error)) {
      delete insertData.card_number;
      const retryResult = await supabaseAdmin
        .from("cards")
        .insert(insertData)
        .select()
        .maybeSingle();
      card = retryResult.data;
      error = retryResult.error;
    }

    if (error && isMissingCardMediaTypeColumnError(error) && normalizedMediaType === "image") {
      delete insertData.media_type;
      const retryResult = await supabaseAdmin
        .from("cards")
        .insert(insertData)
        .select()
        .maybeSingle();
      card = retryResult.data;
      error = retryResult.error;
    }

    if (error) {
      if (isCardNumberConflictError(error)) {
        return NextResponse.json(
          { error: CARD_NUMBER_MESSAGES.duplicate },
          { status: 409 }
        );
      }
      return handleDatabaseError(error, "Cards API: Failed to create card");
    }

    // 再計算はベストエフォート: カード作成は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    try {
      recalculatedCards = await recalculateIfAutoMode(
        supabaseAdmin,
        streamerId,
        streamer.rarity_weights
      );
    } catch (recalculationError) {
      logger.error("Cards API: Recalculation failed after card creation", recalculationError);
    }

    // Note: Cache invalidation is handled by TTL (30 seconds)
    // Short TTL ensures new cards appear quickly without manual invalidation
    // 注意: キャッシュ無効化はTTL（30秒）で処理
    // 短いTTLにより手動で無効化せずとも新しいカードがすぐに表示される

    return NextResponse.json({
      ...card,
      recalculatedCards,
    });
  } catch (error) {
    return handleApiError(error, "Cards API: POST");
  }
}

// Valid sort fields for cards
// カードの有効な並び替えフィールド
const VALID_SORT_FIELDS = ["created_at", "rarity", "drop_rate", "card_number", "display_order"] as const;
type SortField = typeof VALID_SORT_FIELDS[number];

// Valid sort directions
// 有効な並び替え方向
const VALID_SORT_DIRECTIONS = ["asc", "desc"] as const;
type SortDirection = typeof VALID_SORT_DIRECTIONS[number];

// Valid status filters
// 有効なステータスフィルター
const VALID_STATUS_FILTERS = ["all", "active", "inactive"] as const;
type StatusFilter = typeof VALID_STATUS_FILTERS[number];

/**
 * Internal function to fetch cards from database (used for caching)
 * データベースからカードを取得する内部関数（キャッシュ用）
 */
async function fetchCardsFromDB(
  streamerId: string,
  limit: number,
  offset: number,
  sortField: SortField,
  sortDirection: SortDirection,
  statusFilter: StatusFilter,
  includeInactive: boolean
): Promise<{ cards: unknown[]; count: number | null }> {
  const start = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  let query = supabaseAdmin
    .from("cards")
    .select("*", { count: "exact" })
    .eq("streamer_id", streamerId);

  // Apply status filter
  // ステータスフィルターを適用
  if (statusFilter === "active") {
    query = query.eq("is_active", true);
  } else if (statusFilter === "inactive") {
    query = query.eq("is_active", false);
  } else if (!includeInactive && statusFilter === "all") {
    // Legacy behavior handled in caller
  }

  // Apply sorting - all fields use DB-side sorting for correct pagination
  // 並び替えを適用 - ページネーション整合性のため全フィールドDB側でソート
  const ascending = sortDirection === "asc";
  // Use stable DB-side ordering for correct pagination.
  // display_order uses manually assigned card numbers first, then old cards first.
  const dbSortField = sortField === "rarity"
    ? "rarity_order"
    : sortField === "display_order"
      ? "card_number"
      : sortField;
  query = query.order(dbSortField, { ascending, nullsFirst: false });
  if (sortField === "display_order") {
    query = query.order("created_at", { ascending: true, nullsFirst: false });
  }
  query = query.range(offset, offset + limit - 1);

  let { data: cards, error, count } = await query;
  if (
    error &&
    (sortField === "card_number" || sortField === "display_order") &&
    isMissingCardNumberColumnError(error)
  ) {
    const fallbackQuery = supabaseAdmin
      .from("cards")
      .select("*", { count: "exact" })
      .eq("streamer_id", streamerId);

    let filteredFallbackQuery = fallbackQuery;
    if (statusFilter === "active") {
      filteredFallbackQuery = filteredFallbackQuery.eq("is_active", true);
    } else if (statusFilter === "inactive") {
      filteredFallbackQuery = filteredFallbackQuery.eq("is_active", false);
    }

    const fallbackResult = await filteredFallbackQuery
      .order("created_at", { ascending, nullsFirst: false })
      .range(offset, offset + limit - 1);
    cards = fallbackResult.data;
    error = fallbackResult.error;
    count = fallbackResult.count;
  }
  if (error) throw error;

  logger.info(`[Perf] fetchCardsFromDB: ${Date.now() - start}ms (${cards?.length || 0} cards)`);

  return { cards: normalizeDropRate(cards || []), count };
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);
  const streamerId = searchParams.get("streamerId");
  // Pagination parameters
  // ページネーションパラメータ
  // CardManager requests limit=1000 to load all cards for management view
  // カード管理画面では全カード取得のためlimit=1000でリクエストされる
  const limit = Math.min(parseInt(searchParams.get("limit") || "12", 10), 1000);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  // Sorting parameters (default: created_at desc)
  // 並び替えパラメータ（デフォルト: created_at 降順）
  const sortFieldParam = searchParams.get("sortField") || "created_at";
  const sortField: SortField = VALID_SORT_FIELDS.includes(sortFieldParam as SortField)
    ? sortFieldParam as SortField
    : "created_at";
  const sortDirParam = searchParams.get("sortDirection") || "desc";
  const sortDirection: SortDirection = VALID_SORT_DIRECTIONS.includes(sortDirParam as SortDirection)
    ? sortDirParam as SortDirection
    : "desc";

  // Status filter parameter (default: all for includeInactive=true, active otherwise)
  // ステータスフィルターパラメータ（デフォルト: includeInactive=trueならall、それ以外はactive）
  const statusParam = searchParams.get("status");
  const statusFilter: StatusFilter = statusParam && VALID_STATUS_FILTERS.includes(statusParam as StatusFilter)
    ? statusParam as StatusFilter
    : "all";

  // Legacy support: includeInactive parameter
  // レガシーサポート: includeInactiveパラメータ
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
      .maybeSingle();

    if (streamerError || !streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Use cached fetch to reduce CPU usage from repeated queries
    // 繰り返しクエリによるCPU使用量を削減するためキャッシュ済みフェッチを使用
    const cacheKey = `cards-${streamerId}-${limit}-${offset}-${sortField}-${sortDirection}-${statusFilter}-${includeInactive}`;
    const cachedFetch = unstable_cache(
      async () => fetchCardsFromDB(streamerId, limit, offset, sortField, sortDirection, statusFilter, includeInactive),
      [cacheKey],
      {
        revalidate: CARDS_CACHE_TTL,
        tags: [`cards-${streamerId}`],
      }
    );

    const { cards, count } = await cachedFetch();

    // Return paginated response with metadata
    // メタデータ付きのページネーションレスポンスを返す
    return NextResponse.json({
      cards,
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
