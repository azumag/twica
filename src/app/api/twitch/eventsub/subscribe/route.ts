import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { reportError } from "@/lib/sentry/error-handler";

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

      // 既存サブスクリプション数と状態をログに記録
      const mySubscriptions = existingData.data.filter(
        (sub: { type: string; condition: { broadcaster_user_id: string }; status: string }) =>
          sub.type === "channel.channel_points_custom_reward_redemption.add" &&
          sub.condition.broadcaster_user_id === session.twitchUserId
      );
      logger.info(
        `Existing EventSub subscriptions for broadcaster=${session.twitchUserId}: count=${mySubscriptions.length}`,
        { subscriptions: mySubscriptions.map((s: { id: string; status: string; condition: { reward_id: string } }) => ({ id: s.id, status: s.status, rewardId: s.condition.reward_id })) }
      );

      // Delete existing subscriptions for this broadcaster
      // 既存のサブスクリプションを削除（同じreward_idのものがあると409エラーになるため）
      for (const sub of existingData.data) {
        if (
          sub.type === "channel.channel_points_custom_reward_redemption.add" &&
          sub.condition.broadcaster_user_id === session.twitchUserId
        ) {
          logger.info(`Deleting existing EventSub: id=${sub.id}, status=${sub.status}, rewardId=${sub.condition.reward_id}`);
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

          // 削除結果を確認（204は成功、404は既に削除済み）
          if (!deleteResponse.ok && deleteResponse.status !== 404) {
            const deleteError = await deleteResponse.json().catch(() => ({}));
            logger.error(
              `Failed to delete existing EventSub: id=${sub.id}, status=${deleteResponse.status}`,
              deleteError
            );
            // 削除に失敗した場合でも続行するが、警告をログに残す
          } else {
            logger.info(`Successfully deleted EventSub: id=${sub.id}`);
          }
        }
      }

      // 削除後に少し待機（Twitch API側の反映を待つ）
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      // 既存サブスクリプション取得失敗もログに記録
      logger.warn(
        `Failed to get existing EventSub subscriptions: status=${existingResponse.status}`,
        await existingResponse.json().catch(() => ({}))
      );
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

      // 409 Conflict: サブスクリプションが既に存在する場合
      // 既存のサブスクリプションを取得して返す
      if (subscribeResponse.status === 409) {
        logger.warn(
          `EventSub subscription already exists: broadcaster=${session.twitchUserId}, rewardId=${rewardId}`,
          { error }
        );

        // 既存のサブスクリプションを再取得
        const recheckResponse = await fetch(
          `${TWITCH_API_URL}/eventsub/subscriptions`,
          {
            headers: {
              "Authorization": `Bearer ${appAccessToken}`,
              "Client-Id": process.env.TWITCH_CLIENT_ID!,
            },
          }
        );

        if (recheckResponse.ok) {
          const recheckData = await recheckResponse.json();
          const existingSub = recheckData.data.find(
            (sub: { type: string; condition: { broadcaster_user_id: string; reward_id: string } }) =>
              sub.type === "channel.channel_points_custom_reward_redemption.add" &&
              sub.condition.broadcaster_user_id === session.twitchUserId &&
              sub.condition.reward_id === rewardId
          );

          if (existingSub) {
            // 既存のサブスクリプションが見つかった場合、それを返す
            logger.info(
              `Found existing EventSub subscription: id=${existingSub.id}, status=${existingSub.status}`,
              { existingSub }
            );

            // callback URLが異なる場合は警告
            if (existingSub.transport?.callback !== callbackUrl) {
              logger.warn(
                `Existing subscription has different callback URL: expected=${callbackUrl}, actual=${existingSub.transport?.callback}`
              );
            }

            return NextResponse.json({
              success: true,
              subscription: existingSub,
              message: "既存のサブスクリプションを使用しています",
            });
          }
        }

        // 既存のサブスクリプションが見つからない場合はエラーを返す
        return NextResponse.json(
          {
            error: "サブスクリプションが既に存在しますが、取得できませんでした。しばらく待ってから再試行してください。",
            details: error,
          },
          { status: 409 }
        );
      }

      // EventSub登録失敗の詳細をログに記録
      logger.error(
        `EventSub subscription failed: status=${subscribeResponse.status}, broadcaster=${session.twitchUserId}, rewardId=${rewardId}`,
        {
          error,
          callbackUrl,
          status: subscribeResponse.status,
        }
      );
      reportError(new Error(`EventSub subscription failed: ${error.message || JSON.stringify(error)}`), {
        context: "EventSub Subscribe",
        type: "eventsub",
        twitchUserId: session.twitchUserId,
        rewardId,
        callbackUrl,
        errorDetails: error,
      });
      return handleApiError(error, "EventSub subscription error");
    }

    const subscriptionData = await subscribeResponse.json();

    // EventSub登録成功をログに記録
    logger.info(
      `EventSub subscription created: broadcaster=${session.twitchUserId}, rewardId=${rewardId}, subscriptionId=${subscriptionData.data[0]?.id}`,
      { status: subscriptionData.data[0]?.status }
    );

    return NextResponse.json({
      success: true,
      subscription: subscriptionData.data[0],
    });
  } catch (error) {
    return handleApiError(error, "EventSub Subscribe API");
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

    // 現在の設定されているcallback URLをデバッグ情報として追加
    const expectedCallbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`;

    // 各サブスクリプションのcallback URLと期待値が一致するかチェック
    const subscriptionsWithDebug = mySubscriptions.map((sub: {
      id: string;
      status: string;
      transport?: { callback?: string };
    }) => ({
      ...sub,
      debug: {
        expectedCallbackUrl,
        callbackMatch: sub.transport?.callback === expectedCallbackUrl,
      },
    }));

    return NextResponse.json(subscriptionsWithDebug);
  } catch (error) {
    return handleApiError(error, "EventSub Get Subscriptions API");
  }
}
