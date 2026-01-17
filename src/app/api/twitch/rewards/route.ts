import { NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

export async function GET(request: Request) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.twitchRewardsGet, identifier);

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

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "No access token available" }, { status: 401 });
  }

  try {
    const response = await fetch(
      `${TWITCH_API_URL}/channel_points/custom_rewards?broadcaster_id=${session.twitchUserId}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      return handleApiError(error, "Twitch API rewards fetch");
    }

    const data = await response.json();
    return NextResponse.json(data.data || []);
  } catch (error) {
    return handleApiError(error, "Twitch rewards fetch");
  }
}

// Create a new custom reward
export async function POST(request: Request) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.twitchRewardsPost, identifier);

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

  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: "No access token available" }, { status: 401 });
  }

  try {
    const response = await fetch(
      `${TWITCH_API_URL}/channel_points/custom_rewards?broadcaster_id=${session.twitchUserId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "TwiCa カードガチャ",
          cost: 100,
          prompt: "カードガチャを1回引きます",
          is_enabled: true,
          background_color: "#9147FF",
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      return handleApiError(error, "Twitch API reward creation");
    }

    const data = await response.json();
    return NextResponse.json(data.data[0]);
  } catch (error) {
    return handleApiError(error, "Twitch reward creation");
  }
}
