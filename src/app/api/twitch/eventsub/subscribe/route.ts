import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

// Get app access token for EventSub subscriptions
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

export async function POST(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.eventsubSubscribePost, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "リクエストが多すぎます。しばらく待ってから再試行してください。" },
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { rewardId } = body;

    if (!rewardId) {
      return NextResponse.json({ error: "Missing rewardId" }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Get streamer info
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .single();

    if (!streamer) {
      return NextResponse.json({ error: "Streamer not found" }, { status: 404 });
    }

    // Get app access token
    const appAccessToken = await getAppAccessToken();

    // Callback URL for EventSub
    const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`;

    // Check existing subscriptions
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
      logger.error("EventSub subscription error:", error);
      return NextResponse.json(
        { error: "Failed to subscribe to EventSub", details: error },
        { status: subscribeResponse.status }
      );
    }

    const subscriptionData = await subscribeResponse.json();
    logger.info("EventSub subscription created:", subscriptionData);

    return NextResponse.json({
      success: true,
      subscription: subscriptionData.data[0],
    });
  } catch (error) {
    logger.error("Error subscribing to EventSub:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// Get current subscriptions
export async function GET(request: Request) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.eventsubSubscribeGet, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json(
      { error: "リクエストが多すぎます。しばらく待ってから再試行してください。" },
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
        { error: "Failed to get subscriptions", details: error },
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
    logger.error("Error getting EventSub subscriptions:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
