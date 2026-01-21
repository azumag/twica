import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  validateCardName,
  validateImageUrl,
  validateRarity,
} from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import type { ApiRateLimitResponse } from "@/types/api";
import type { Rarity } from "@/types/database";

/**
 * Card data for batch creation
 * 一括作成用のカードデータ
 */
interface BatchCardInput {
  name: string;
  imageUrl: string;
  rarity: Rarity;
  dropRate: number;
  description?: string;
}

/**
 * POST /api/cards/batch
 * Creates multiple cards at once (e.g., from Twitch emotes)
 * 複数のカードを一度に作成（例：Twitchエモートから）
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
    const { streamerId, cards } = body as { streamerId: string; cards: BatchCardInput[] };

    // Validate request structure
    // リクエスト構造の検証
    if (!streamerId || !Array.isArray(cards) || cards.length === 0) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.MISSING_REQUIRED_FIELDS },
        { status: 400 }
      );
    }

    // Limit batch size to prevent abuse
    // 乱用防止のためバッチサイズを制限
    const MAX_BATCH_SIZE = 50;
    if (cards.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `一度に作成できるカードは${MAX_BATCH_SIZE}枚までです` },
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

    // Validate each card
    // 各カードを検証
    const validationErrors: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];

      const nameValidation = validateCardName(card.name);
      if (!nameValidation.valid) {
        validationErrors.push(`カード${i + 1}: ${nameValidation.error}`);
        continue;
      }

      const imageUrlValidation = validateImageUrl(card.imageUrl);
      if (!imageUrlValidation.valid) {
        validationErrors.push(`カード${i + 1}: ${imageUrlValidation.error}`);
        continue;
      }

      const rarityValidation = validateRarity(card.rarity);
      if (!rarityValidation.valid) {
        validationErrors.push(`カード${i + 1}: ${rarityValidation.error}`);
        continue;
      }

      if (typeof card.dropRate !== "number" || card.dropRate < 0 || card.dropRate > 1) {
        validationErrors.push(`カード${i + 1}: ${ERROR_MESSAGES.DROP_RATE_INVALID}`);
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json(
        { error: validationErrors.join("; ") },
        { status: 400 }
      );
    }

    // Prepare cards for insertion
    // 挿入用にカードを準備
    const cardsToInsert = cards.map((card) => ({
      streamer_id: streamerId,
      name: card.name,
      description: card.description || "",
      image_url: card.imageUrl,
      rarity: card.rarity,
      drop_rate: card.dropRate,
    }));

    // Insert all cards at once
    // 全カードを一度に挿入
    const { data: createdCards, error } = await supabaseAdmin
      .from("cards")
      .insert(cardsToInsert)
      .select();

    if (error) {
      return handleDatabaseError(error, "Cards Batch API: Failed to create cards");
    }

    return NextResponse.json({
      success: true,
      created: createdCards?.length || 0,
      cards: createdCards,
    });
  } catch (error) {
    return handleApiError(error, "Cards Batch API: POST");
  }
}
