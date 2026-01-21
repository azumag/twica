import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";
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
import { extractTwitchUserId } from "@/types/database";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { logger } from "@/lib/logger";
import { deleteFromR2 } from "@/lib/r2-client";
import { removeBlobFile } from "@/lib/storage-db";
import { isR2Url, isVercelBlobUrl, isStorageUrl, getR2KeyFromUrl } from "@/lib/storage-utils";
import type { ApiRateLimitResponse } from "@/types/api";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: csrfValidation.error || ERROR_MESSAGES.FORBIDDEN, code: 'CSRF_VALIDATION_FAILED' },
      { status: 403 }
    )
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsId, identifier);

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

  const { id } = await params;

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { name, description, imageUrl, rarity, dropRate, isActive } = body;

    if (name !== undefined) {
      const nameValidation = validateCardName(name)
      if (!nameValidation.valid) {
        return NextResponse.json(
          { error: nameValidation.error },
          { status: 400 }
        )
      }
    }

    if (description !== undefined) {
      const descriptionValidation = validateCardDescription(description)
      if (!descriptionValidation.valid) {
        return NextResponse.json(
          { error: descriptionValidation.error },
          { status: 400 }
        )
      }
    }

    if (imageUrl !== undefined) {
      const imageUrlValidation = validateImageUrl(imageUrl)
      if (!imageUrlValidation.valid) {
        return NextResponse.json(
          { error: imageUrlValidation.error },
          { status: 400 }
        )
      }
    }

    if (rarity !== undefined) {
      const rarityValidation = validateRarity(rarity)
      if (!rarityValidation.valid) {
        return NextResponse.json(
          { error: rarityValidation.error },
          { status: 400 }
        )
      }
    }

    if (dropRate !== undefined) {
      if (typeof dropRate !== "number" || dropRate < 0 || dropRate > 1) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.DROP_RATE_INVALID },
          { status: 400 }
        );
      }
    }

    // Verify ownership
    const { data: card } = await supabaseAdmin
      .from("cards")
      .select("streamer_id, streamers!inner(twitch_user_id)")
      .eq("id", id)
      .single();

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // NOTE: Drop rate validation removed because the system uses relative weights
    // The actual probability is calculated as: this_card_weight / total_weights
    // So there's no need to limit the sum to 100% - weights are relative, not absolute percentages
    // 注意: ドロップレート検証を削除。システムは相対重みを使用するため
    // 実際の確率は「このカードの重み / 全体の重み」で計算される
    // 重みは相対的であり絶対的な割合ではないため、合計100%制限は不要

    // 更新するフィールドを動的に構築（undefined のフィールドは更新しない）
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (imageUrl !== undefined) updateData.image_url = imageUrl;
    if (rarity !== undefined) updateData.rarity = rarity;
    if (dropRate !== undefined) updateData.drop_rate = dropRate;
    if (isActive !== undefined) updateData.is_active = isActive;

    const { data: updatedCard, error } = await supabaseAdmin
      .from("cards")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return handleDatabaseError(error, "Failed to update card");
    }

    return NextResponse.json(updatedCard);
  } catch (error) {
    return handleApiError(error, "Cards API: PUT");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: csrfValidation.error || ERROR_MESSAGES.FORBIDDEN, code: 'CSRF_VALIDATION_FAILED' },
      { status: 403 }
    )
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsId, identifier);

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

  const { id } = await params;

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // Get card with image_url for deletion
    // 削除用にimage_url付きでカードを取得
    const { data: card } = await supabaseAdmin
      .from("cards")
      .select("streamer_id, image_url, streamers!inner(twitch_user_id)")
      .eq("id", id)
      .single();

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Delete image from storage if it exists (R2 or Vercel Blob)
    // ストレージから画像を削除（存在する場合、R2またはVercel Blob）
    if (card.image_url && isStorageUrl(card.image_url)) {
      try {
        // DBからファイル情報を削除し、使用量を減算
        await removeBlobFile(card.image_url);
      } catch (dbError) {
        // DB操作に失敗しても続行
        logger.warn(`Failed to remove blob file from DB: ${card.image_url}`, dbError);
      }

      try {
        if (isR2Url(card.image_url)) {
          // R2から削除
          const key = getR2KeyFromUrl(card.image_url);
          if (key) {
            await deleteFromR2(key);
            logger.info(`Deleted R2 image: ${card.image_url}`);
          }
        } else if (isVercelBlobUrl(card.image_url)) {
          // Vercel Blobから削除（既存データ用）
          await del(card.image_url);
          logger.info(`Deleted Vercel Blob image: ${card.image_url}`);
        }
      } catch (storageError) {
        // Log but don't fail the card deletion if storage deletion fails
        // ストレージ削除が失敗してもカード削除は続行（ログのみ記録）
        logger.warn(`Failed to delete storage image: ${card.image_url}`, storageError);
      }
    }

    const { error } = await supabaseAdmin
      .from("cards")
      .delete()
      .eq("id", id);

    if (error) {
      return handleDatabaseError(error, "Failed to delete card");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Cards API: DELETE");
  }
}
