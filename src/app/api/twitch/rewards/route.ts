import { NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

async function getAccessToken(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

export async function GET() {
  const session = await getSession();

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
      logger.error("Twitch API error:", error);

      if (response.status === 403) {
        return NextResponse.json(
          { error: "チャネルポイントが有効になっていないか、アフィリエイト/パートナーではありません" },
          { status: 403 }
        );
      }

      return NextResponse.json(
        { error: "報酬の取得に失敗しました" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data.data || []);
  } catch (error) {
    logger.error("Error fetching rewards:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// Create a new custom reward
export async function POST() {
  const session = await getSession();

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
      logger.error("Twitch API error:", error);
      return NextResponse.json(
        { error: "報酬の作成に失敗しました" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data.data[0]);
  } catch (error) {
    logger.error("Error creating reward:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
