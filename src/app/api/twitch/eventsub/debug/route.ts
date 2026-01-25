import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { handleApiError } from "@/lib/error-handler";
import { ERROR_MESSAGES } from "@/lib/constants";
import { logger } from "@/lib/logger";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

/**
 * EventSubサブスクリプションのデバッグ用エンドポイント
 * 現在のサブスクリプション状態を詳細に取得する
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

// EventSubサブスクリプションの型定義（デバッグ用）
type EventSubSubscription = {
  id: string;
  status: string;
  type: string;
  condition: { broadcaster_user_id: string; reward_id?: string };
  transport: { method: string; callback: string };
  created_at: string;
};

// すべてのEventSubサブスクリプションを取得（デバッグ用・ページネーション対応）
// subscribe/route.tsと同様に配列を返すように統一
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
        "Client-Id": process.env.TWITCH_CLIENT_ID!,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch subscriptions: ${response.status}`);
    }

    const data = await response.json();
    allData.push(...data.data);
    cursor = data.pagination?.cursor;
  } while (cursor);

  // 配列を返す（totalはallData.lengthから取得可能）
  return allData;
}

export async function GET(request: NextRequest) {
  const session = await getSession();

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const appAccessToken = await getAppAccessToken();

    // ページネーションを使ってすべてのサブスクリプションを取得
    const allSubscriptions = await getAllSubscriptions(appAccessToken);

    // このbroadcasterのサブスクリプションのみフィルタ
    const mySubscriptions = allSubscriptions.filter(
      (sub) => sub.condition.broadcaster_user_id === session.twitchUserId
    );

    // 全サブスクリプション情報を返す（デバッグ用）
    // totalはallSubscriptions.lengthから取得（subscribe/route.tsと同じ方式）
    return NextResponse.json({
      broadcasterId: session.twitchUserId,
      clientId: process.env.TWITCH_CLIENT_ID,
      expectedCallbackUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/twitch/eventsub`,
      total: allSubscriptions.length,
      mySubscriptions: mySubscriptions.map((sub: EventSubSubscription) => ({
        id: sub.id,
        status: sub.status,
        type: sub.type,
        rewardId: sub.condition.reward_id,
        callback: sub.transport.callback,
        createdAt: sub.created_at,
      })),
    });
  } catch (error) {
    return handleApiError(error, "EventSub Debug GET");
  }
}

// 特定のEventSubサブスクリプションを削除
export async function DELETE(request: NextRequest) {
  const session = await getSession();

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const subscriptionId = searchParams.get("id");
    const deleteAll = searchParams.get("all") === "true";

    const appAccessToken = await getAppAccessToken();

    if (deleteAll) {
      // すべてのサブスクリプションを削除
      const listResponse = await fetch(
        `${TWITCH_API_URL}/eventsub/subscriptions`,
        {
          headers: {
            "Authorization": `Bearer ${appAccessToken}`,
            "Client-Id": process.env.TWITCH_CLIENT_ID!,
          },
        }
      );

      if (!listResponse.ok) {
        return NextResponse.json({ error: "Failed to list subscriptions" }, { status: 500 });
      }

      const listData = await listResponse.json();
      const mySubscriptions = listData.data.filter(
        (sub: { condition: { broadcaster_user_id: string } }) =>
          sub.condition.broadcaster_user_id === session.twitchUserId
      );

      const results = [];
      for (const sub of mySubscriptions) {
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
        results.push({
          id: sub.id,
          status: deleteResponse.status,
          success: deleteResponse.status === 204,
        });
        logger.info(`Deleted subscription: id=${sub.id}, status=${deleteResponse.status}`);
      }

      return NextResponse.json({
        message: `Deleted ${results.filter(r => r.success).length}/${mySubscriptions.length} subscriptions`,
        results,
      });
    }

    if (!subscriptionId) {
      return NextResponse.json({ error: "Missing subscription id" }, { status: 400 });
    }

    // 単一のサブスクリプションを削除
    const deleteResponse = await fetch(
      `${TWITCH_API_URL}/eventsub/subscriptions?id=${subscriptionId}`,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${appAccessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
        },
      }
    );

    if (deleteResponse.status === 204) {
      logger.info(`Deleted subscription: id=${subscriptionId}`);
      return NextResponse.json({ success: true, message: "Subscription deleted" });
    } else {
      const error = await deleteResponse.json().catch(() => ({}));
      return NextResponse.json(
        { error: "Failed to delete subscription", details: error },
        { status: deleteResponse.status }
      );
    }
  } catch (error) {
    return handleApiError(error, "EventSub Debug DELETE");
  }
}
