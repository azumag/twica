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
import { extractTwitchUserId } from "@/types/database";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { logger } from "@/lib/logger";
import { deleteFromR2 } from "@/lib/r2-client";
import { removeBlobFile } from "@/lib/storage-db";
import { isR2Url, isVercelBlobUrl, isStorageUrl, getR2KeyFromUrl } from "@/lib/storage-utils";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
import type { ApiRateLimitResponse } from "@/types/api";

function extractRarityWeights(streamers: unknown): Record<string, number> | null {
  if (!streamers) return null;
  if (Array.isArray(streamers)) {
    const first = streamers[0];
    if (first && typeof first === "object" && "rarity_weights" in first) {
      return (first as { rarity_weights: Record<string, number> | null }).rarity_weights;
    }
    return null;
  }
  if (typeof streamers === "object" && "rarity_weights" in streamers) {
    return (streamers as { rarity_weights: Record<string, number> | null }).rarity_weights;
  }
  return null;
}

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

    // Verify ownership and get current image_url for cleanup
    // 所有権を確認し、クリーンアップ用に現在のimage_urlを取得
    const { data: card } = await supabaseAdmin
      .from("cards")
      .select("streamer_id, image_url, rarity, is_active, streamers!inner(twitch_user_id, rarity_weights)")
      .eq("id", id)
      .maybeSingle();

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const rarityWeights = extractRarityWeights(card.streamers);
    const rarityChanged = rarity !== undefined && rarity !== card.rarity;
    const activeChanged = isActive !== undefined && isActive !== card.is_active;
    const shouldRecalculate = rarityWeights !== null && (rarityChanged || activeChanged);

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

    // Delete old image if imageUrl is being changed to a different URL
    // imageUrlが異なるURLに変更される場合、古い画像を削除
    const oldImageUrl = card.image_url;
    const isImageChanging = imageUrl !== undefined && imageUrl !== oldImageUrl;

    if (isImageChanging && oldImageUrl && isStorageUrl(oldImageUrl)) {
      // Remove from DB and update usage
      // DBから削除し使用量を更新
      try {
        await removeBlobFile(oldImageUrl);
      } catch (dbError) {
        logger.warn(`Failed to remove old image from DB: ${oldImageUrl}`, dbError);
      }

      // Delete from storage (R2)
      // ストレージから削除（R2）
      // Note: Vercel Blob deletion removed - only R2 is supported now
      // 注意: Vercel Blob削除を削除 - R2のみサポート
      try {
        if (isR2Url(oldImageUrl)) {
          const key = getR2KeyFromUrl(oldImageUrl);
          if (key) {
            await deleteFromR2(key);
            logger.info(`Deleted old R2 image on update: ${oldImageUrl}`);
          }
        } else if (isVercelBlobUrl(oldImageUrl)) {
          // Vercel Blob URLs are no longer actively deleted
          // Migration to R2 should have moved these files
          logger.warn(`Vercel Blob URL found but deletion skipped: ${oldImageUrl}`);
        }
      } catch (storageError) {
        logger.warn(`Failed to delete old storage image: ${oldImageUrl}`, storageError);
      }
    }

    const { data: updatedCard, error } = await supabaseAdmin
      .from("cards")
      .update(updateData)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      return handleDatabaseError(error, "Failed to update card");
    }

    // 再計算はベストエフォート: カード更新は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    if (shouldRecalculate) {
      try {
        recalculatedCards = await recalculateIfAutoMode(
          supabaseAdmin,
          card.streamer_id,
          rarityWeights
        );
      } catch (recalculationError) {
        logger.error("Cards API: Recalculation failed after card update", recalculationError);
      }
    }

    return NextResponse.json({
      ...updatedCard,
      recalculatedCards,
    });
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
      .select("streamer_id, image_url, streamers!inner(twitch_user_id, rarity_weights)")
      .eq("id", id)
      .maybeSingle();

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
          // Vercel Blob URLs are no longer actively deleted
          // Migration to R2 should have moved these files
          // Vercel Blob URLは削除しない（R2移行済みのはず）
          logger.warn(`Vercel Blob URL found but deletion skipped: ${card.image_url}`);
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

    // 再計算はベストエフォート: カード削除は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    const rarityWeights = extractRarityWeights(card.streamers);
    if (rarityWeights !== null) {
      try {
        recalculatedCards = await recalculateIfAutoMode(
          supabaseAdmin,
          card.streamer_id,
          rarityWeights
        );
      } catch (recalculationError) {
        logger.error("Cards API: Recalculation failed after card deletion", recalculationError);
      }
    }

    return NextResponse.json({ success: true, recalculatedCards });
  } catch (error) {
    return handleApiError(error, "Cards API: DELETE");
  }
}
