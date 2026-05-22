import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { ADDITIONAL_SCOPES } from "@/lib/twitch/scopes";
import { getTwitchAccessToken, hasScope } from "@/lib/twitch/token-manager";
import {
  deriveEventSubStatus,
  type EventSubSubscriptionForStatus,
} from "@/lib/twitch/eventsub-status";
import { logPerf, perfStart } from "@/lib/perf";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

interface TwitchReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
}

function isRaidOptionsSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204"
    || message.includes("draw_count")
    || message.includes("is_raid_limited")
    || message.includes("guaranteed_rarity");
}

function isRaidStateSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204"
    || message.includes("raid_gacha_active_until")
    || message.includes("raid_gacha_draw_count")
    || message.includes("raid_gacha_guaranteed_rarity");
}

async function getTwitchRewards(twitchUserId: string): Promise<{ rewards: TwitchReward[]; requiresReauth?: boolean; error?: string }> {
  const accessToken = await getTwitchAccessToken(twitchUserId);
  if (!accessToken) {
    return { rewards: [], requiresReauth: true };
  }

  const response = await fetch(
    `${TWITCH_API_URL}/channel_points/custom_rewards?broadcaster_id=${twitchUserId}`,
    {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Client-Id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
      },
    }
  );

  if (response.status === 401) {
    return { rewards: [], requiresReauth: true };
  }

  if (response.status === 403) {
    return { rewards: [], error: "affiliateRequired" };
  }

  if (!response.ok) {
    return { rewards: [], error: "fetchFailed" };
  }

  const data = await response.json();
  return { rewards: data.data || [] };
}

async function getAppAccessToken(): Promise<string> {
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
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

async function getSubscriptionsByUserId(
  appAccessToken: string,
  userId: string,
): Promise<EventSubSubscriptionForStatus[]> {
  const allData: EventSubSubscriptionForStatus[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(`${TWITCH_API_URL}/eventsub/subscriptions`);
    url.searchParams.set("user_id", userId);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);

    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${appAccessToken}`,
        "Client-Id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch EventSub subscriptions: status=${response.status}`);
    }

    const data = await response.json();
    allData.push(...(data.data || []));
    cursor = data.pagination?.cursor;
  } while (cursor);

  return allData;
}

async function getAdditionalRewards(streamerId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  let { data: rewards, error } = await supabaseAdmin
    .from("streamer_additional_gacha_rewards")
    .select("id, reward_id, reward_name, draw_count, is_raid_limited, guaranteed_rarity, created_at")
    .eq("streamer_id", streamerId)
    .order("created_at", { ascending: true });

  if (isRaidOptionsSchemaError(error)) {
    const fallbackResult = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .select("id, reward_id, reward_name, created_at")
      .eq("streamer_id", streamerId)
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
    throw error;
  }

  return rewards || [];
}

async function getOwnedStreamer(twitchUserId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  let { data: streamer, error } = await supabaseAdmin
    .from("streamers")
    .select("id, channel_point_reward_id, raid_gacha_draw_count, raid_gacha_guaranteed_rarity")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (isRaidStateSchemaError(error)) {
    const fallbackResult = await supabaseAdmin
      .from("streamers")
      .select("id, channel_point_reward_id")
      .eq("twitch_user_id", twitchUserId)
      .maybeSingle();
    streamer = fallbackResult.data
      ? { ...fallbackResult.data, raid_gacha_draw_count: 0, raid_gacha_guaranteed_rarity: null }
      : fallbackResult.data;
    error = fallbackResult.error;
  }

  return { streamer, error };
}

export async function GET(request: NextRequest) {
  const startedAt = perfStart();
  const diagnostics = request.nextUrl.searchParams.get("diagnostics") === "1";

  try {
    const session = await getSession();
    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.twitchRewardsGet, identifier);

    if (!rateLimitResult.success) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
        { status: 429 },
      );
    }

    if (!session || !canUseStreamerFeatures(session)) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
    }

    const hasRequiredScope = await hasScope(
      session.twitchUserId,
      ADDITIONAL_SCOPES.CHANNEL_READ_REDEMPTIONS,
    );

    if (!hasRequiredScope) {
      return NextResponse.json({
        hasRequiredScope: false,
        rewards: [],
        requiresReauth: true,
      });
    }

    const { rewards, requiresReauth, error } = await getTwitchRewards(session.twitchUserId);
    const responsePayload: Record<string, unknown> = {
      hasRequiredScope: true,
      rewards,
      requiresReauth,
      error,
    };

    if (diagnostics && !requiresReauth) {
      const { streamer, error: streamerError } = await getOwnedStreamer(session.twitchUserId);
      if (streamerError) return handleDatabaseError(streamerError, "Channel Point Bootstrap API");
      if (!streamer) return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });

      const appAccessToken = await getAppAccessToken();
      const subscriptions = await getSubscriptionsByUserId(appAccessToken, session.twitchUserId);
      const expectedCallbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`;
      const subscriptionsWithDebug = subscriptions.map((sub) => ({
        ...sub,
        debug: {
          expectedCallbackUrl,
          callbackMatch: sub.transport?.callback === expectedCallbackUrl,
        },
      }));
      const status = deriveEventSubStatus(
        subscriptionsWithDebug,
        streamer.channel_point_reward_id || "",
      );

      responsePayload.subscriptions = subscriptionsWithDebug;
      responsePayload.eventSubStatus = status.rewardStatus;
      responsePayload.raidEventSubStatus = status.raidStatus;
      responsePayload.additionalRewards = await getAdditionalRewards(streamer.id);
      responsePayload.raidGiftDrawCount = streamer.raid_gacha_draw_count ?? 0;
      responsePayload.raidGiftGuaranteedRarity = streamer.raid_gacha_guaranteed_rarity ?? null;
    }

    return NextResponse.json(responsePayload);
  } catch (error) {
    return handleApiError(error, "Channel Point Bootstrap API");
  } finally {
    logPerf("api", "channel-point-bootstrap", startedAt, { diagnostics });
  }
}
