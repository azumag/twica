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
      .maybeSingle();

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

    // 同一IDが複数含まれると、RPC関数のROW_COUNTと期待件数が不一致になり
    // 誤って「部分更新」と判定されるため、重複を事前に排除
    const cardIds = updates.map(u => u.id);
    const uniqueCardIds = new Set(cardIds);
    if (uniqueCardIds.size !== cardIds.length) {
      return NextResponse.json(
        { error: "同じカードIDが複数含まれています" },
        { status: 400 }
      );
    }
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

    // RPC関数を使って全カードのdrop_rateを1回のDB呼び出しで一括更新
    // 従来は各カードごとに個別のSupabase UPDATE（=個別のHTTP fetch）を発行していたが、
    // Cloudflare Workersのサブリクエスト上限（50回/リクエスト）を超過するため、
    // PostgreSQLストアドプロシージャで1リクエストに集約
    const rpcPayload = updates.map(u => ({ id: u.id, drop_rate: u.dropRate }));
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
      "batch_update_card_drop_rates",
      {
        p_streamer_id: streamerId,
        p_updates: rpcPayload,
      }
    );

    if (rpcError) {
      return handleDatabaseError(rpcError, "Cards Batch Update API: Failed to update cards");
    }

    // RPC関数が返す更新件数と期待件数を照合し、一部のカードが更新されなかった場合を検出
    const updatedCount = rpcResult?.updated_count ?? 0;
    if (updatedCount !== updates.length) {
      return handleDatabaseError(
        { message: `Expected ${updates.length} updates but only ${updatedCount} succeeded`, details: "", hint: "", code: "" },
        "Cards Batch Update API: Partial update detected"
      );
    }

    // 更新後のカードデータを取得して返す
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
