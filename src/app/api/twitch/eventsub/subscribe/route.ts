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

// ページネーション対応でEventSubサブスクリプションを取得
// Twitch APIは一度に最大100件しか返さないため、cursorを使って全ページを取得
// user_idパラメータを使用することで、特定ユーザーのサブスクリプションのみを効率的に取得
// これにより全件取得→メモリ内フィルタリングが不要になり、APIコールとデータ転送量を削減
interface EventSubSubscription {
  id: string;
  status: string;
  type: string;
  condition: { broadcaster_user_id: string; reward_id?: string };
  transport: { method: string; callback: string };
  created_at: string;
}

async function getSubscriptionsByUserId(
  appAccessToken: string,
  userId: string
): Promise<EventSubSubscription[]> {
  const allData: EventSubSubscription[] = [];
  let cursor: string | undefined;

  do {
    // user_idパラメータでフィルタリングし、対象ユーザーのサブスクリプションのみを取得
    // Twitch API側でフィルタリングされるため、全件取得より効率的
    const baseUrl = `${TWITCH_API_URL}/eventsub/subscriptions?user_id=${userId}`;
    const url = cursor ? `${baseUrl}&after=${cursor}` : baseUrl;

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

    logger.info(`Fetched ${data.data.length} subscriptions for user=${userId}, total so far: ${allData.length}, hasMore: ${!!cursor}`);
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
    const { rewardId, isAdditional } = body;

    if (!rewardId) {
      return NextResponse.json({ error: ERROR_MESSAGES.MISSING_REWARD_ID }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Get streamer info
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Get app access token
    const appAccessToken = await getAppAccessToken();

    // Callback URL for EventSub
    const callbackUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`;

    // user_idパラメータで対象ユーザーのサブスクリプションのみを取得
    // Twitch API側でフィルタリングされるため、全件取得より効率的
    const userSubscriptions = await getSubscriptionsByUserId(appAccessToken, session.twitchUserId);

    // 既存サブスクリプション数と状態をログに記録
    // channel_points_custom_reward_redemption.addタイプのサブスクリプションをフィルタリング
    const mySubscriptions = userSubscriptions.filter(
      (sub) => sub.type === "channel.channel_points_custom_reward_redemption.add"
    );
    logger.info(
      `Existing EventSub subscriptions for broadcaster=${session.twitchUserId}: count=${mySubscriptions.length} (total for user: ${userSubscriptions.length})`,
      { subscriptions: mySubscriptions.map((s) => ({ id: s.id, status: s.status, rewardId: s.condition.reward_id, callback: s.transport.callback })) }
    );

    // 登録する報酬IDと一致するサブスクリプションのみ削除（他の報酬のサブスクリプションは保持）
    // メイン報酬でも追加報酬でも同じロジック：対象の報酬のみ削除して再登録
    // Only delete subscription matching the reward_id being registered (keep other rewards)
    // Same logic for both main and additional rewards: delete only the target reward and re-register
    const subscriptionsToDelete = mySubscriptions.filter(
      (sub) => sub.condition.reward_id === rewardId
    );

    // Delete existing subscription for the target reward only
    // 対象報酬のサブスクリプションのみ削除
    for (const sub of subscriptionsToDelete) {
      logger.info(`Deleting existing EventSub for target reward: id=${sub.id}, status=${sub.status}, rewardId=${sub.condition.reward_id}, callback=${sub.transport.callback}`);
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
    if (subscriptionsToDelete.length > 0) {
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

        // user_idパラメータで対象ユーザーのサブスクリプションを再取得
        const recheckUserSubs = await getSubscriptionsByUserId(appAccessToken, session.twitchUserId);

        // channel_points_custom_reward_redemption.addタイプのサブスクリプションをフィルタリング（デバッグ用）
        const allMySubs = recheckUserSubs.filter(
          (sub) => sub.type === "channel.channel_points_custom_reward_redemption.add"
        );
        logger.info(
          `All EventSub subscriptions after 409: count=${allMySubs.length} (total for user: ${recheckUserSubs.length})`,
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

/**
 * DELETE: チャネルポイント連携を解除する
 * EventSubサブスクリプション（channel.channel_points_custom_reward_redemption.add タイプ）を削除
 * Delete channel point integration by removing EventSub subscriptions
 *
 * Query parameters:
 * - ?rewardId=xxx: Delete subscription for specific reward ID only
 * - (no params): Delete all channel point subscriptions for the broadcaster
 */
export async function DELETE(request: NextRequest) {
  const session = await getSession();

  // レートリミットチェック（POST と同じリミットを適用）
  // Apply same rate limit as POST to prevent abuse
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

  // ストリーマー権限チェック
  // Verify streamer permissions
  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const appAccessToken = await getAppAccessToken();
    const url = new URL(request.url);
    const specificRewardId = url.searchParams.get("rewardId");

    // 対象ユーザーのサブスクリプションを取得
    // Get subscriptions for this user using user_id filter
    const userSubscriptions = await getSubscriptionsByUserId(appAccessToken, session.twitchUserId);

    // channel_points_custom_reward_redemption.add タイプのみフィルタ
    // Filter to only channel point redemption subscriptions
    let mySubscriptions = userSubscriptions.filter(
      (sub) => sub.type === "channel.channel_points_custom_reward_redemption.add"
    );

    // If rewardId is specified, filter to only that reward
    // rewardIdが指定されている場合は、その報酬のみにフィルタ
    if (specificRewardId) {
      mySubscriptions = mySubscriptions.filter(
        (sub) => sub.condition.reward_id === specificRewardId
      );
      logger.info(
        `Deleting EventSub subscription for specific reward: broadcaster=${session.twitchUserId}, rewardId=${specificRewardId}, found ${mySubscriptions.length} subscriptions`
      );
    } else {
      logger.info(
        `Deleting all EventSub subscriptions for broadcaster=${session.twitchUserId}: found ${mySubscriptions.length} subscriptions`,
        { subscriptions: mySubscriptions.map((s) => ({ id: s.id, status: s.status, rewardId: s.condition.reward_id })) }
      );
    }

    // 各サブスクリプションを削除
    // Delete each subscription
    const results = [];
    for (const sub of mySubscriptions) {
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

      // 204: 成功、404: 既に削除済み（どちらも成功扱い）
      // 204: Success, 404: Already deleted (both count as success)
      const success = deleteResponse.status === 204 || deleteResponse.status === 404;
      results.push({
        id: sub.id,
        rewardId: sub.condition.reward_id,
        success,
        status: deleteResponse.status,
      });

      if (success) {
        logger.info(`Successfully deleted EventSub subscription: id=${sub.id}, rewardId=${sub.condition.reward_id}`);
      } else {
        logger.error(`Failed to delete EventSub subscription: id=${sub.id}, status=${deleteResponse.status}`);
      }
    }

    const successCount = results.filter(r => r.success).length;
    logger.info(`EventSub deletion complete: ${successCount}/${mySubscriptions.length} subscriptions deleted`);

    return NextResponse.json({
      success: true,
      message: `Deleted ${successCount}/${mySubscriptions.length} subscriptions`,
      deletedCount: successCount,
      totalCount: mySubscriptions.length,
      results,
    });
  } catch (error) {
    logger.error("EventSub Unsubscribe API error:", error);
    return handleApiError(error, "EventSub Unsubscribe API");
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

    // user_idパラメータで対象ユーザーのサブスクリプションのみを取得
    // Twitch API側でフィルタリングされるため、全件取得→メモリ内フィルタリングが不要
    // これによりAPIコールとデータ転送量を大幅に削減
    const mySubscriptions = await getSubscriptionsByUserId(appAccessToken, session.twitchUserId);

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
