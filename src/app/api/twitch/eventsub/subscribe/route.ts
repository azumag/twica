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

// ページネーション対応でEventSubサブスクリプションを全件取得
// Twitch APIは一度に最大100件しか返さないため、cursorを使って全ページを取得
interface EventSubSubscription {
  id: string;
  status: string;
  type: string;
  condition: { broadcaster_user_id: string; reward_id?: string };
  transport: { method: string; callback: string };
  created_at: string;
}

async function getAllSubscriptions(appAccessToken: string): Promise<EventSubSubscription[]> {
  const allData: EventSubSubscription[] = [];
  let cursor: string | undefined;

  do {
    const url = cursor
      ? `${TWITCH_API_URL}/eventsub/subscriptions?after=${cursor}`
      : `${TWITCH_API_URL}/eventsub/subscriptions`;

    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${appAccessToken}`,
        "Client-Id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
      },
    });

    if (!response.ok) {
      logger.error(`Failed to fetch subscriptions page: ${response.status}`);
      break;
    }

    const data = await response.json();
    allData.push(...data.data);
    cursor = data.pagination?.cursor;

    logger.info(`Fetched ${data.data.length} subscriptions, total so far: ${allData.length}, hasMore: ${!!cursor}`);
  } while (cursor);

  return allData;
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

    // ページネーション対応で全サブスクリプションを取得
    const allSubscriptions = await getAllSubscriptions(appAccessToken);

    // 既存サブスクリプション数と状態をログに記録
    const mySubscriptions = allSubscriptions.filter(
      (sub) =>
        sub.type === "channel.channel_points_custom_reward_redemption.add" &&
        sub.condition.broadcaster_user_id === session.twitchUserId
    );
    logger.info(
      `Existing EventSub subscriptions for broadcaster=${session.twitchUserId}: count=${mySubscriptions.length} (total in system: ${allSubscriptions.length})`,
      { subscriptions: mySubscriptions.map((s) => ({ id: s.id, status: s.status, rewardId: s.condition.reward_id, callback: s.transport.callback })) }
    );

    // Delete existing subscriptions for this broadcaster
    // 既存のサブスクリプションを削除（同じreward_idのものがあると409エラーになるため）
    for (const sub of mySubscriptions) {
      logger.info(`Deleting existing EventSub: id=${sub.id}, status=${sub.status}, rewardId=${sub.condition.reward_id}, callback=${sub.transport.callback}`);
      const deleteResponse = await fetch(
        `${TWITCH_API_URL}/eventsub/subscriptions?id=${sub.id}`,
        {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${appAccessToken}`,
            "Client-Id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
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

    // 削除後に少し待機（Twitch API側の反映を待つ）
    if (mySubscriptions.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Create new subscription
    const subscribeResponse = await fetch(
      `${TWITCH_API_URL}/eventsub/subscriptions`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${appAccessToken}`,
          "Client-Id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
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

        // ページネーション対応で既存のサブスクリプションを再取得
        const allRecheckSubs = await getAllSubscriptions(appAccessToken);

        // すべてのサブスクリプションをログに記録（デバッグ用）
        const allMySubs = allRecheckSubs.filter(
          (sub) =>
            sub.type === "channel.channel_points_custom_reward_redemption.add" &&
            sub.condition.broadcaster_user_id === session.twitchUserId
        );
        logger.info(
          `All EventSub subscriptions after 409: count=${allMySubs.length} (total in system: ${allRecheckSubs.length})`,
          { subscriptions: allMySubs.map((s) => ({
            id: s.id,
            status: s.status,
            rewardId: s.condition.reward_id,
            callback: s.transport?.callback,
          })) }
        );

        const existingSub = allMySubs.find(
          (sub) => sub.condition.reward_id === rewardId
        );

        if (existingSub) {
          // 既存のサブスクリプションが見つかった場合、それを返す（200 OK）
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

        // 同じbroadcasterの他のサブスクリプションが見つかった場合
        // それらを削除して再試行する
        if (allMySubs.length > 0) {
          logger.info(`Found ${allMySubs.length} subscriptions for other rewards, attempting cleanup`);

          for (const sub of allMySubs) {
            const delResponse = await fetch(
              `${TWITCH_API_URL}/eventsub/subscriptions?id=${sub.id}`,
              {
                method: "DELETE",
                headers: {
                  "Authorization": `Bearer ${appAccessToken}`,
                  "Client-Id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
                },
              }
            );
            logger.info(`Cleanup delete: id=${sub.id}, status=${delResponse.status}`);
          }

          // 削除後に待機して再試行
          await new Promise(resolve => setTimeout(resolve, 1000));

          // 再試行
          const retryResponse = await fetch(
            `${TWITCH_API_URL}/eventsub/subscriptions`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${appAccessToken}`,
                "Client-Id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
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

          if (retryResponse.ok) {
            const retryData = await retryResponse.json();
            logger.info(`Retry successful: subscriptionId=${retryData.data[0]?.id}`);
            return NextResponse.json({
              success: true,
              subscription: retryData.data[0],
              message: "クリーンアップ後に登録しました",
            });
          } else {
            const retryError = await retryResponse.json();
            logger.error(`Retry failed: status=${retryResponse.status}`, retryError);
          }
        }

        // 既存のサブスクリプションが見つからない場合でも、警告として扱う
        // （ユーザーにリトライを促す）
        logger.warn(
          `409 conflict but subscription not found, returning partial success`,
          { rewardId, broadcasterId: session.twitchUserId }
        );
        return NextResponse.json({
          success: false,
          warning: true,
          message: "サブスクリプションの状態を確認してください。既に登録されている可能性があります。",
        });
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

    // ページネーション対応で全サブスクリプションを取得
    // 1ページ目だけだと、サブスクリプションが多い場合に見つからない問題がある
    const allSubscriptions = await getAllSubscriptions(appAccessToken);

    // Filter to only this broadcaster's subscriptions
    const mySubscriptions = allSubscriptions.filter(
      (sub) =>
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
