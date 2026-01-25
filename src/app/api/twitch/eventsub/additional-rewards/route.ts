import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

/**
 * Get app access token for EventSub subscriptions
 * EventSubサブスクリプション用のアプリアクセストークンを取得
 */
async function getAppAccessToken(): Promise<string> {
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID!,
      client_secret: process.env.TWITCH_CLIENT_SECRET!,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) {
    throw new Error("Failed to get app access token");
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * POST - Add a new additional gacha reward
 * 追加ガチャ報酬を新規登録
 *
 * This endpoint:
 * 1. Saves the additional reward to the database
 * 2. Creates an EventSub subscription for the reward
 *
 * このエンドポイント:
 * 1. 追加報酬をデータベースに保存
 * 2. 報酬用のEventSubサブスクリプションを作成
 */
export async function POST(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.eventsubSubscribePost, identifier);

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
    const body = await request.json();
    const { rewardId, rewardName } = body;

    if (!rewardId) {
      return NextResponse.json({ error: ERROR_MESSAGES.MISSING_REWARD_ID }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Get streamer info
    // ストリーマー情報を取得
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id, channel_point_reward_id")
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Check if this reward is already the main reward
    // この報酬がすでにメイン報酬かどうかチェック
    if (streamer.channel_point_reward_id === rewardId) {
      return NextResponse.json(
        { error: "This reward is already set as the main gacha reward" },
        { status: 400 }
      );
    }

    // Check if this reward is already registered as an additional reward
    // この報酬がすでに追加報酬として登録されているかチェック
    const { data: existingReward } = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .select("id")
      .eq("streamer_id", streamer.id)
      .eq("reward_id", rewardId)
      .maybeSingle();

    if (existingReward) {
      return NextResponse.json(
        { error: "This reward is already registered as an additional gacha reward" },
        { status: 400 }
      );
    }

    // Get app access token
    // アプリアクセストークンを取得
    const appAccessToken = await getAppAccessToken();

    // Callback URL for EventSub
    const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`;

    // Create EventSub subscription for the additional reward
    // 追加報酬用のEventSubサブスクリプションを作成
    const subscribeResponse = await fetch(
      `${TWITCH_API_URL}/eventsub/subscriptions`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${appAccessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "channel.channel_points_custom_reward_redemption.add",
          version: "1",
          condition: {
            broadcaster_user_id: session.twitchUserId,
            reward_id: rewardId,
          },
          transport: {
            method: "webhook",
            callback: callbackUrl,
            secret: process.env.TWITCH_EVENTSUB_SECRET,
          },
        }),
      }
    );

    if (!subscribeResponse.ok) {
      const error = await subscribeResponse.json();
      return handleApiError(error, "EventSub subscription error");
    }

    // Save the additional reward to the database
    // 追加報酬をデータベースに保存
    const { data: newReward, error: insertError } = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .insert({
        streamer_id: streamer.id,
        reward_id: rewardId,
        reward_name: rewardName || null,
      })
      .select()
      .single();

    if (insertError) {
      return handleApiError(insertError, "Failed to save additional reward");
    }

    return NextResponse.json({
      success: true,
      reward: newReward,
    });
  } catch (error) {
    return handleApiError(error, "Additional Rewards API");
  }
}

/**
 * GET - Get all additional gacha rewards for the current streamer
 * 現在のストリーマーの追加ガチャ報酬一覧を取得
 */
export async function GET(request: Request) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.eventsubSubscribeGet, identifier);

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

    // Get streamer info
    // ストリーマー情報を取得
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Get all additional rewards for this streamer
    // このストリーマーの全追加報酬を取得
    const { data: additionalRewards, error } = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .select("*")
      .eq("streamer_id", streamer.id)
      .order("created_at", { ascending: false });

    if (error) {
      return handleApiError(error, "Failed to get additional rewards");
    }

    return NextResponse.json(additionalRewards || []);
  } catch (error) {
    return handleApiError(error, "Additional Rewards GET API");
  }
}

/**
 * DELETE - Remove an additional gacha reward
 * 追加ガチャ報酬を削除
 *
 * Query parameter: rewardId - the reward ID to delete
 */
export async function DELETE(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.eventsubSubscribePost, identifier);

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
    const { searchParams } = new URL(request.url);
    const rewardId = searchParams.get("rewardId");

    if (!rewardId) {
      return NextResponse.json({ error: ERROR_MESSAGES.MISSING_REWARD_ID }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Get streamer info
    // ストリーマー情報を取得
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Get app access token
    // アプリアクセストークンを取得
    const appAccessToken = await getAppAccessToken();

    // Find and delete the EventSub subscription for this reward
    // この報酬のEventSubサブスクリプションを検索して削除
    const existingResponse = await fetch(
      `${TWITCH_API_URL}/eventsub/subscriptions`,
      {
        headers: {
          "Authorization": `Bearer ${appAccessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
        },
      }
    );

    if (existingResponse.ok) {
      const existingData = await existingResponse.json();

      // Delete the subscription for this specific reward
      // この特定の報酬のサブスクリプションを削除
      for (const sub of existingData.data) {
        if (
          sub.type === "channel.channel_points_custom_reward_redemption.add" &&
          sub.condition.broadcaster_user_id === session.twitchUserId &&
          sub.condition.reward_id === rewardId
        ) {
          await fetch(
            `${TWITCH_API_URL}/eventsub/subscriptions?id=${sub.id}`,
            {
              method: "DELETE",
              headers: {
                "Authorization": `Bearer ${appAccessToken}`,
                "Client-Id": process.env.TWITCH_CLIENT_ID!,
              },
            }
          );
        }
      }
    }

    // Delete the additional reward from the database
    // データベースから追加報酬を削除
    const { error: deleteError } = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .delete()
      .eq("streamer_id", streamer.id)
      .eq("reward_id", rewardId);

    if (deleteError) {
      return handleApiError(deleteError, "Failed to delete additional reward");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Additional Rewards DELETE API");
  }
}
