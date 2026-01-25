import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { logger } from "@/lib/logger";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

// Get app access token for EventSub subscriptions
// アプリケーション認証用のアクセストークンを取得する
// Twitch OAuth2のclient_credentialsフローを使用
async function getAppAccessToken(): Promise<string> {
  logger.info("[EventSub] Getting app access token...");

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
    const errorText = await response.text();
    logger.error(`[EventSub] Failed to get app access token: status=${response.status}, body=${errorText}`);
    throw new Error(`Failed to get app access token: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  logger.info("[EventSub] App access token obtained successfully");
  return data.access_token;
}

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
    const { rewardId } = body;

    if (!rewardId) {
      return NextResponse.json({ error: ERROR_MESSAGES.MISSING_REWARD_ID }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Get streamer info
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Get app access token
    // EventSubの操作にはアプリケーション認証トークンが必要
    const appAccessToken = await getAppAccessToken();

    // Callback URL for EventSub
    // Twitch からのWebhook通知を受け取るURL
    const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`;
    logger.info(`[EventSub] Callback URL: ${callbackUrl}`);

    // Check existing subscriptions
    // 既存のサブスクリプションを確認して、同一ブロードキャスターの古いものを削除する
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

      // Delete existing subscriptions for this broadcaster
      for (const sub of existingData.data) {
        if (
          sub.type === "channel.channel_points_custom_reward_redemption.add" &&
          sub.condition.broadcaster_user_id === session.twitchUserId
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

    // Create new subscription
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
      // EventSub登録失敗時の詳細をログに記録
      // Twitch APIのエラーレスポンスには通常 message フィールドが含まれる
      logger.error(`[EventSub] Subscription failed: status=${subscribeResponse.status}, error=${JSON.stringify(error)}`);
      logger.error(`[EventSub] Request details: broadcaster_user_id=${session.twitchUserId}, reward_id=${rewardId}, callback=${callbackUrl}`);

      // クライアントにも詳細なエラー情報を返す（デバッグ用）
      return NextResponse.json(
        {
          error: "EventSub subscription failed",
          details: error,
          status: subscribeResponse.status,
          callbackUrl: callbackUrl,
        },
        { status: subscribeResponse.status }
      );
    }

    const subscriptionData = await subscribeResponse.json();
    logger.info(`[EventSub] Subscription created successfully: id=${subscriptionData.data[0]?.id}, status=${subscriptionData.data[0]?.status}`);

    return NextResponse.json({
      success: true,
      subscription: subscriptionData.data[0],
    });
  } catch (error) {
    logger.error(`[EventSub] Unexpected error in POST: ${error}`);
    return handleApiError(error, "EventSub Subscribe API");
  }
}

// Delete EventSub subscription for a specific reward
// 特定の報酬のEventSubサブスクリプションを削除
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

    // Get app access token
    const appAccessToken = await getAppAccessToken();

    // Get existing subscriptions
    const existingResponse = await fetch(
      `${TWITCH_API_URL}/eventsub/subscriptions`,
      {
        headers: {
          "Authorization": `Bearer ${appAccessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
        },
      }
    );

    if (!existingResponse.ok) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FAILED_TO_GET_SUBSCRIPTIONS },
        { status: existingResponse.status }
      );
    }

    const existingData = await existingResponse.json();
    let deletedCount = 0;

    // Delete subscriptions for this broadcaster (and optionally for specific reward)
    // この配信者のサブスクリプションを削除（オプションで特定の報酬のみ）
    for (const sub of existingData.data) {
      if (
        sub.type === "channel.channel_points_custom_reward_redemption.add" &&
        sub.condition.broadcaster_user_id === session.twitchUserId
      ) {
        // rewardIdが指定されている場合は、そのrewardIdのみ削除
        // If rewardId is specified, only delete that rewardId's subscription
        if (rewardId && sub.condition.reward_id !== rewardId) {
          continue;
        }

        const deleteResponse = await fetch(
          `${TWITCH_API_URL}/eventsub/subscriptions?id=${sub.id}`,
          {
            method: "DELETE",
            headers: {
              "Authorization": `Bearer ${appAccessToken}`,
              "Client-Id": process.env.TWITCH_CLIENT_ID!,
            },
          }
        );

        if (deleteResponse.ok || deleteResponse.status === 204) {
          deletedCount++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      deletedCount,
    });
  } catch (error) {
    return handleApiError(error, "EventSub Delete Subscription API");
  }
}

// Get current subscriptions
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
    const appAccessToken = await getAppAccessToken();

    const response = await fetch(
      `${TWITCH_API_URL}/eventsub/subscriptions`,
      {
        headers: {
          "Authorization": `Bearer ${appAccessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      return NextResponse.json(
        { error: ERROR_MESSAGES.FAILED_TO_GET_SUBSCRIPTIONS, details: error },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Filter to only this broadcaster's subscriptions
    const mySubscriptions = data.data.filter(
      (sub: { condition: { broadcaster_user_id: string } }) =>
        sub.condition.broadcaster_user_id === session.twitchUserId
    );

    return NextResponse.json(mySubscriptions);
  } catch (error) {
    return handleApiError(error, "EventSub Get Subscriptions API");
  }
}
