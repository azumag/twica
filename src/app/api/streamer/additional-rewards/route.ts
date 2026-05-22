import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { logger } from "@/lib/logger";
import { isGuaranteedRarity, normalizeGuaranteedRarity } from "@/lib/rarity";

function isRaidOptionsSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204"
    || message.includes("draw_count")
    || message.includes("is_raid_limited")
    || message.includes("guaranteed_rarity");
}

const RAID_OPTIONS_SCHEMA_PENDING_MESSAGE =
  "追加報酬のN連ガチャ設定がまだDBに反映されていません。少し待ってから再度追加してください。";

/**
 * GET: ストリーマーの追加報酬一覧を取得
 * Fetch additional gacha rewards for the current streamer
 */
export async function GET(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();

    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Fetch all additional rewards for this streamer
    // このストリーマーの全ての追加報酬を取得
    let { data: rewards, error } = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .select("id, reward_id, reward_name, draw_count, is_raid_limited, guaranteed_rarity, created_at")
      .eq("streamer_id", streamer.id)
      .order("created_at", { ascending: true });

    if (isRaidOptionsSchemaError(error)) {
      const fallbackResult = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .select("id, reward_id, reward_name, created_at")
        .eq("streamer_id", streamer.id)
        .order("created_at", { ascending: true });
      rewards = (fallbackResult.data || []).map((reward) => ({
        ...reward,
        draw_count: 1,
        is_raid_limited: false,
        guaranteed_rarity: null,
      }));
      error = fallbackResult.error;
    }

    if (error) {
      return handleDatabaseError(error, "Additional Rewards API: GET");
    }

    // キャッシュを無効化して、削除後も常に最新のデータを返す
    // Disable caching to ensure fresh data is returned after deletions
    return NextResponse.json(rewards || [], {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    return handleApiError(error, "Additional Rewards API: GET");
  }
}

/**
 * POST: 新しい追加報酬を登録
 * Register a new additional gacha reward
 */
export async function POST(request: NextRequest) {
  // Content-Type validation - must be the first check
  const contentTypeValidation = validateContentType(request, "application/json");
  if (contentTypeValidation) {
    return contentTypeValidation;
  }

  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    );
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { rewardId, rewardName, drawCount, isRaidLimited, guaranteedRarity: guaranteedRarityInput } = body;

    if (!rewardId) {
      return NextResponse.json({ error: ERROR_MESSAGES.MISSING_REWARD_ID }, { status: 400 });
    }

    const normalizedDrawCount = drawCount === undefined ? 1 : Number(drawCount);
    if (!Number.isInteger(normalizedDrawCount) || normalizedDrawCount < 1 || normalizedDrawCount > 10) {
      return NextResponse.json(
        { error: "drawCount must be an integer between 1 and 10" },
        { status: 400 }
      );
    }

    if (isRaidLimited !== undefined && typeof isRaidLimited !== "boolean") {
      return NextResponse.json(
        { error: "isRaidLimited must be a boolean" },
        { status: 400 }
      );
    }

    if (
      guaranteedRarityInput !== undefined
      && guaranteedRarityInput !== null
      && guaranteedRarityInput !== ""
      && !isGuaranteedRarity(guaranteedRarityInput)
    ) {
      return NextResponse.json(
        { error: "guaranteedRarity must be one of rare, epic, legendary, or null" },
        { status: 400 }
      );
    }
    const guaranteedRarity = normalizeGuaranteedRarity(guaranteedRarityInput);

    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id, channel_point_reward_id")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Check if main reward is set (additional rewards require main reward to be configured first)
    // メイン報酬が設定されているか確認（追加報酬はメイン報酬設定後のみ追加可能）
    if (!streamer.channel_point_reward_id) {
      return NextResponse.json(
        { error: "メイン報酬を先に設定してください" },
        { status: 400 }
      );
    }

    // Check if the reward is already the main reward
    // メイン報酬と同じIDでないか確認
    if (streamer.channel_point_reward_id === rewardId) {
      return NextResponse.json(
        { error: "この報酬はメイン報酬として既に設定されています" },
        { status: 400 }
      );
    }

    // Insert the new additional reward
    // 新しい追加報酬を挿入
    const { data: newReward, error } = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .insert({
        streamer_id: streamer.id,
        reward_id: rewardId,
        reward_name: rewardName || null,
        draw_count: normalizedDrawCount,
        is_raid_limited: isRaidLimited ?? false,
        guaranteed_rarity: normalizedDrawCount >= 2 ? guaranteedRarity : null,
      })
      .select()
      .maybeSingle();

    if (isRaidOptionsSchemaError(error)) {
      logger.warn("Additional reward options schema is not ready; refusing to create a 1-draw fallback reward", {
        rewardId,
        streamerId: streamer.id,
        requestedDrawCount: normalizedDrawCount,
        error: error?.message,
      });
      return NextResponse.json(
        { error: RAID_OPTIONS_SCHEMA_PENDING_MESSAGE },
        { status: 503 }
      );
    }

    if (error) {
      // Handle unique constraint violation (reward already added)
      // 一意制約違反を処理（報酬は既に追加済み）
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "この報酬は既に追加されています" },
          { status: 409 }
        );
      }
      return handleDatabaseError(error, "Additional Rewards API: POST");
    }

    logger.info(
      `Additional reward registered: streamerId=${streamer.id}, rewardId=${rewardId}, rewardName=${rewardName}, drawCount=${normalizedDrawCount}, raidLimited=${isRaidLimited ?? false}, guaranteedRarity=${normalizedDrawCount >= 2 ? guaranteedRarity ?? "none" : "none"}`
    );

    return NextResponse.json({ success: true, reward: newReward });
  } catch (error) {
    return handleApiError(error, "Additional Rewards API: POST");
  }
}

/**
 * DELETE: 追加報酬を削除
 * Delete additional gacha reward(s)
 * - ?rewardId=xxx: Delete specific reward
 * - ?deleteAll=true: Delete all additional rewards for the streamer
 */
export async function DELETE(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const supabaseAdmin = getSupabaseAdmin();
    const url = new URL(request.url);
    const rewardId = url.searchParams.get("rewardId");
    const deleteAll = url.searchParams.get("deleteAll") === "true";

    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    if (deleteAll) {
      // Delete all additional rewards for this streamer
      // このストリーマーの全ての追加報酬を削除
      const { error, count } = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .delete()
        .eq("streamer_id", streamer.id)
        .select();

      if (error) {
        return handleDatabaseError(error, "Additional Rewards API: DELETE ALL");
      }

      logger.info(
        `All additional rewards deleted: streamerId=${streamer.id}, count=${count}`
      );

      return NextResponse.json({ success: true, deletedCount: count });
    } else if (rewardId) {
      // Delete specific reward
      // 特定の報酬を削除
      const { error } = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .delete()
        .eq("streamer_id", streamer.id)
        .eq("reward_id", rewardId);

      if (error) {
        return handleDatabaseError(error, "Additional Rewards API: DELETE");
      }

      logger.info(
        `Additional reward deleted: streamerId=${streamer.id}, rewardId=${rewardId}`
      );

      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json(
        { error: "rewardId または deleteAll パラメータが必要です" },
        { status: 400 }
      );
    }
  } catch (error) {
    return handleApiError(error, "Additional Rewards API: DELETE");
  }
}
