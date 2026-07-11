import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { logger } from "@/lib/logger";
import { resolveCollectionNameField, isRegisteredOrUnchanged, DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import {
  checkCollectionHasActiveCards,
  isMissingCollectionNameColumn,
  isMissingCardPackNamesColumnError,
} from "@/lib/collections/collection-existence";

function isRaidOptionsSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204" || message.includes("draw_count") || message.includes("is_raid_limited");
}

const RAID_OPTIONS_SCHEMA_PENDING_MESSAGE =
  "追加の引き換えのN連ガチャ設定がまだDBに反映されていません。少し待ってから再度追加してください。";

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
      .select("id, reward_id, reward_name, draw_count, is_raid_limited, collection_name, created_at")
      .eq("streamer_id", streamer.id)
      .order("created_at", { ascending: true });

    // Issue #393: handle "only collection_name column missing" BEFORE the raid
    // fallback. Both match PGRST204, but the raid fallback would wrongly reset
    // draw_count / is_raid_limited, losing N-draw config. So check this first and
    // fall back to "all cards" (collection_name: null) while keeping raid options.
    // collection_name 列のみ未デプロイのケースを raid fallback より先に処理する。
    if (error && isMissingCollectionNameColumn(error)) {
      const fallbackResult = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .select("id, reward_id, reward_name, draw_count, is_raid_limited, created_at")
        .eq("streamer_id", streamer.id)
        .order("created_at", { ascending: true });
      rewards = (fallbackResult.data || []).map((reward) => ({
        ...reward,
        collection_name: null,
      }));
      error = fallbackResult.error;
    }

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
        collection_name: null,
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
    const { rewardId, rewardName, drawCount, isRaidLimited } = body;

    // Issue #393: optional pack binding for this additional reward.
    const collectionNameResult = resolveCollectionNameField(body, "collectionName");
    if (!collectionNameResult.ok) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    if (!rewardId) {
      return NextResponse.json({ error: ERROR_MESSAGES.MISSING_REWARD_ID }, { status: 400 });
    }

    const normalizedDrawCount = drawCount === undefined ? 1 : Number(drawCount);
    // Issue #641: upper bound raised from 10 to 15 (fixed limit, confirmed by owner).
    if (!Number.isInteger(normalizedDrawCount) || normalizedDrawCount < 1 || normalizedDrawCount > 15) {
      return NextResponse.json(
        { error: "drawCount must be an integer between 1 and 15" },
        { status: 400 }
      );
    }

    if (isRaidLimited !== undefined && typeof isRaidLimited !== "boolean") {
      return NextResponse.json(
        { error: "isRaidLimited must be a boolean" },
        { status: 400 }
      );
    }

    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    let { data: streamer, error: streamerSelectError } = await supabaseAdmin
      .from("streamers")
      .select("id, channel_point_reward_id, card_pack_names")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    // Issue #393再設計: card_pack_names がデプロイ窓で未検出の場合、それだけ
    // 外して再試行する(所有権確認・メイン報酬確認は継続できるようにする)。
    let cardPackNamesUnavailable = false;
    if (streamerSelectError && isMissingCardPackNamesColumnError(streamerSelectError)) {
      const retryResult = await supabaseAdmin
        .from("streamers")
        .select("id, channel_point_reward_id")
        .eq("twitch_user_id", session.twitchUserId)
        .maybeSingle();
      streamer = retryResult.data ? { ...retryResult.data, card_pack_names: [] as string[] } : null;
      streamerSelectError = retryResult.error;
      cardPackNamesUnavailable = true;
    }

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Check if main reward is set (additional rewards require main reward to be configured first)
    // メイン報酬が設定されているか確認（追加報酬はメイン報酬設定後のみ追加可能）
    if (!streamer.channel_point_reward_id) {
      return NextResponse.json(
        { error: "メインの引き換えを先に設定してください" },
        { status: 400 }
      );
    }

    // Check if the reward is already the main reward
    // メイン報酬と同じIDでないか確認
    if (streamer.channel_point_reward_id === rewardId) {
      return NextResponse.json(
        { error: "このチャネルポイント引き換えはメインの引き換えとして既に設定されています" },
        { status: 400 }
      );
    }

    // Issue #393再設計: 追加報酬に更新エンドポイントは無い(作成/削除のみ)ため、
    // 非null値は常に「新規紐付け」として扱い、事前登録済みパック名であることを
    // 要求する(Issue #269のプレミアムゲートは廃止。パック管理モーダルでの
    // 追加時のみゲートする設計に変更したため、ここではmembership検証のみ行う)。
    const registeredPackNames: string[] = Array.isArray(streamer.card_pack_names)
      ? streamer.card_pack_names
      : [];
    // Issue #555: DEFAULT_PACK_SENTINEL is a reserved value that can never be a
    // member of card_pack_names (isReservedCollectionName rejects registering
    // it), so the ordinary membership check would always reject it. Every
    // streamer implicitly has this pseudo-pack (their unclassified cards), so
    // membership validation is skipped for it entirely; existence is verified
    // separately below via checkCollectionHasActiveCards.
    if (
      typeof collectionNameResult.value === "string" &&
      collectionNameResult.value !== DEFAULT_PACK_SENTINEL &&
      !cardPackNamesUnavailable &&
      !isRegisteredOrUnchanged(collectionNameResult.value, null, registeredPackNames)
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
    }

    // デプロイ窓でmembership検証ができない間は、新しいパック紐付けの書き込み
    // 自体を見送る(報酬自体の作成は続行)。
    const collectionNameSkippedDeployWindow =
      cardPackNamesUnavailable && typeof collectionNameResult.value === "string";

    // Issue #393: when a pack is bound, ensure it actually has active cards so the
    // reward never resolves to an empty draw pool at redemption time. Skip the
    // check during the deploy window (column not migrated yet) and when the
    // assignment could not be persisted anyway.
    if (typeof collectionNameResult.value === "string" && !collectionNameSkippedDeployWindow) {
      const existence = await checkCollectionHasActiveCards(
        supabaseAdmin,
        streamer.id,
        collectionNameResult.value
      );
      if (existence === "absent") {
        return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_FOUND }, { status: 400 });
      }
    }

    // Insert the new additional reward
    // 新しい追加報酬を挿入
    // collection_name は値が指定された場合のみ含める。未指定/null の通常作成では
    // 列を含めないことで、collection_name 列が未デプロイでも作成を壊さない。
    const insertPayload: Record<string, unknown> = {
      streamer_id: streamer.id,
      reward_id: rewardId,
      reward_name: rewardName || null,
      draw_count: normalizedDrawCount,
      is_raid_limited: isRaidLimited ?? false,
    };
    if (typeof collectionNameResult.value === "string" && !collectionNameSkippedDeployWindow) {
      insertPayload.collection_name = collectionNameResult.value;
    }

    let { data: newReward, error } = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .insert(insertPayload)
      .select()
      .maybeSingle();

    // Issue #393: deploy-window safety. Strip collection_name and retry if the
    // column is not migrated yet. Must run BEFORE the raid-options check because
    // both match PGRST204; otherwise we would return a misleading 503.
    if (error && isMissingCollectionNameColumn(error) && "collection_name" in insertPayload) {
      delete insertPayload.collection_name;
      const retryResult = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .insert(insertPayload)
        .select()
        .maybeSingle();
      newReward = retryResult.data;
      error = retryResult.error;
    }

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
          { error: "このチャネルポイント引き換えは既に追加されています" },
          { status: 409 }
        );
      }
      return handleDatabaseError(error, "Additional Rewards API: POST");
    }

    logger.info(
      `Additional reward registered: streamerId=${streamer.id}, rewardId=${rewardId}, rewardName=${rewardName}, drawCount=${normalizedDrawCount}, raidLimited=${isRaidLimited ?? false}`
    );

    return NextResponse.json({
      success: true,
      reward: newReward,
      ...(collectionNameSkippedDeployWindow ? { collectionNameSkippedDeployWindow: true } : {}),
    });
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
