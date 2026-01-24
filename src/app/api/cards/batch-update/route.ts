import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import type { ApiRateLimitResponse } from "@/types/api";

/**
 * Drop rate update data for batch processing
 * バッチ処理用のドロップレート更新データ
 */
interface DropRateUpdate {
  id: string;
  dropRate: number;
}

/**
 * POST /api/cards/batch-update
 * Updates drop_rate for multiple cards at once
 * 複数カードのdrop_rateを一括更新
 *
 * Request body:
 * {
 *   streamerId: string,
 *   updates: Array<{ id: string, dropRate: number }>
 * }
 */
export async function POST(request: NextRequest) {
  // Content-Type validation - must be the first check
  // Content-Type検証 - 最初にチェック
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) {
    return contentTypeValidation
  }

  // CSRF token validation
  // CSRFトークン検証
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  const session = await getSession();

  // Rate limiting check
  // レート制限チェック
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

  // Authentication and authorization check
  // 認証・認可チェック
  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { streamerId, updates } = body as { streamerId: string; updates: DropRateUpdate[] };

    // Validate request structure
    // リクエスト構造の検証
    if (!streamerId || !Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.MISSING_REQUIRED_FIELDS },
        { status: 400 }
      );
    }

    // Limit batch size to prevent abuse
    // 乱用防止のためバッチサイズを制限
    const MAX_BATCH_SIZE = 100;
    if (updates.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `一度に更新できるカードは${MAX_BATCH_SIZE}枚までです` },
        { status: 400 }
      );
    }

    // Verify streamer owns this streamer profile
    // 配信者がこのstreamerプロフィールを所有しているか確認
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("id", streamerId)
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Validate each update item
    // 各更新項目を検証
    const validationErrors: string[] = [];
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];

      if (!update.id || typeof update.id !== "string") {
        validationErrors.push(`更新${i + 1}: カードIDが無効です`);
        continue;
      }

      if (typeof update.dropRate !== "number" || update.dropRate < 0 || update.dropRate > 1) {
        validationErrors.push(`更新${i + 1}: ${ERROR_MESSAGES.DROP_RATE_INVALID}`);
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json(
        { error: validationErrors.join("; ") },
        { status: 400 }
      );
    }

    // Verify all cards belong to this streamer
    // 全カードがこの配信者に属しているか確認
    const cardIds = updates.map(u => u.id);
    const { data: existingCards } = await supabaseAdmin
      .from("cards")
      .select("id")
      .eq("streamer_id", streamerId)
      .in("id", cardIds);

    if (!existingCards || existingCards.length !== cardIds.length) {
      return NextResponse.json(
        { error: "一部のカードが見つからないか、アクセス権がありません" },
        { status: 403 }
      );
    }

    // Perform batch update using multiple single updates
    // Supabase doesn't support true batch updates, so we use a transaction-like approach
    // 複数の単一更新を使用してバッチ更新を実行
    // Supabaseは真のバッチ更新をサポートしていないため、トランザクション的なアプローチを使用
    const updatePromises = updates.map(update =>
      supabaseAdmin
        .from("cards")
        .update({ drop_rate: update.dropRate })
        .eq("id", update.id)
        .eq("streamer_id", streamerId)
    );

    const results = await Promise.all(updatePromises);

    // Check for any errors
    // エラーがないかチェック
    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
      return handleDatabaseError(errors[0].error!, "Cards Batch Update API: Failed to update cards");
    }

    // Fetch updated cards to return
    // 更新されたカードを取得して返す
    const { data: updatedCards, error: fetchError } = await supabaseAdmin
      .from("cards")
      .select()
      .eq("streamer_id", streamerId)
      .in("id", cardIds);

    if (fetchError) {
      return handleDatabaseError(fetchError, "Cards Batch Update API: Failed to fetch updated cards");
    }

    return NextResponse.json({
      success: true,
      updated: updates.length,
      cards: updatedCards,
    });
  } catch (error) {
    return handleApiError(error, "Cards Batch Update API: POST");
  }
}
