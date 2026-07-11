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
// Issue #690 (#570 パイロット踏襲): pg 直結の読み取り経路。DB_DRIVER=pg-read/pg の
// ときのみ使われる。getDb() は withDbRetry の queryFn 内で呼ぶ規約
// (src/lib/db/retry.ts 参照)。フラグ未設定時はこれらのモジュールは一切呼ばれない。
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { isPgMissingColumnError } from "@/lib/db/errors";
import {
  streamers as streamersTable,
  streamerAdditionalGachaRewards as streamerAdditionalGachaRewardsTable,
} from "@/lib/db/schema";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

interface TwitchReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
}

function isRaidOptionsSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204" || message.includes("draw_count") || message.includes("is_raid_limited");
}

function isRaidStateSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204"
    || message.includes("raid_gacha_active_until")
    || message.includes("raid_gacha_draw_count");
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

/**
 * Issue #690: getAdditionalRewards の pg 直結実装。
 *
 * PostgREST 実装（下の getAdditionalRewards の postgrest 分岐）との対応:
 * - フル select（id, reward_id, reward_name, draw_count, is_raid_limited,
 *   created_at）を streamer_id で絞り込み created_at 昇順に取得する。
 * - isRaidOptionsSchemaError（PGRST204 or draw_count/is_raid_limited を含む
 *   メッセージ）に相当する「デプロイ窓フォールバック」を pg 版でも維持する。
 *   draw_count・is_raid_limited は migration 00041 で追加された列であり、
 *   マイグレーション未適用の DB に新しいアプリコードがデプロイされる短い窓で
 *   42703 undefined_column が発生しうる（PostgREST の PGRST204 はスキーマ
 *   キャッシュ固有のエラーのため pg 直結では発生しないが、列そのものが無い
 *   場合の 42703 は pg でも起こり得る。本番相当のマイグレーション適用済み
 *   環境ではこの分岐はほぼ発火しないが、src/lib/db/errors.ts の
 *   「デプロイ窓フォールバック」規約（isPgMissingColumnError = 42703 判定）に
 *   準拠して同等の縮退フォールバックを用意しておく）。
 * - 発火条件の差について（厳格レビュー指摘・意図的な差）: pg 側は 42703
 *   （未定義列）のみで発火し、postgrest 側の isRaidOptionsSchemaError
 *   （PGRST204、または message に draw_count/is_raid_limited を含む任意エラー）
 *   より条件が厳密に狭い。支配的シナリオ（デプロイ窓での列欠落そのもの）では
 *   両者とも発火するため一致するが、PGRST204 は PostgREST のスキーマキャッシュ
 *   固有のエラーコードで pg 直結には存在しない概念であり、message 文字列一致による
 *   広い判定を pg 側にそのまま移植する意味がない。db/errors.ts の SQLSTATE
 *   ベース判定規約に沿ってこの差を意図的に許容している。
 * - フォールバック時は draw_count: 1 / is_raid_limited: false を補完する
 *   （PostgREST 版と同じデフォルト値。streamerAdditionalGachaRewards スキーマの
 *   DEFAULT 値とも一致）。
 * - PostgREST 版はエラーを `throw error` するのみで独自の例外型に変換しない。
 *   pg 版も withDbRetry 内で発生した例外をそのまま伝播させる（呼び出し元の
 *   GET ハンドラの try/catch が handleApiError で 500 を返す既存挙動を維持）。
 */
async function getAdditionalRewardsPg(streamerId: string) {
  try {
    return await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            id: streamerAdditionalGachaRewardsTable.id,
            reward_id: streamerAdditionalGachaRewardsTable.reward_id,
            reward_name: streamerAdditionalGachaRewardsTable.reward_name,
            draw_count: streamerAdditionalGachaRewardsTable.draw_count,
            is_raid_limited: streamerAdditionalGachaRewardsTable.is_raid_limited,
            created_at: streamerAdditionalGachaRewardsTable.created_at,
          })
          .from(streamerAdditionalGachaRewardsTable)
          .where(eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId))
          .orderBy(asc(streamerAdditionalGachaRewardsTable.created_at));
      },
      "getAdditionalRewards",
      // 読み取り専用クエリのため冪等（idempotent: true でリトライを opt-in）
      { idempotent: true },
    );
  } catch (error) {
    if (!isPgMissingColumnError(error)) {
      throw error;
    }
    // デプロイ窓フォールバック（42703 undefined_column）: draw_count /
    // is_raid_limited を含めない縮退クエリへ切り替え、PostgREST 版と同じ
    // デフォルト値（draw_count: 1, is_raid_limited: false）を補って返す。
    return await withDbRetry(
      async () => {
        const { db } = await getDb();
        const rows = await db
          .select({
            id: streamerAdditionalGachaRewardsTable.id,
            reward_id: streamerAdditionalGachaRewardsTable.reward_id,
            reward_name: streamerAdditionalGachaRewardsTable.reward_name,
            created_at: streamerAdditionalGachaRewardsTable.created_at,
          })
          .from(streamerAdditionalGachaRewardsTable)
          .where(eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId))
          .orderBy(asc(streamerAdditionalGachaRewardsTable.created_at));
        return rows.map((reward) => ({
          ...reward,
          draw_count: 1,
          is_raid_limited: false,
        }));
      },
      "getAdditionalRewards:raid-options-fallback",
      { idempotent: true },
    );
  }
}

async function getAdditionalRewards(streamerId: string) {
  // Issue #690 (#570 パイロット踏襲): DB_DRIVER=pg-read/pg のときのみ pg 直結の
  // getAdditionalRewardsPg へ切り替える。フラグ未設定時（既定 'postgrest'）は
  // 以下の既存 supabase-js 実装がそのまま実行され、挙動は完全に不変。
  if (isPgReadEnabled()) {
    return getAdditionalRewardsPg(streamerId);
  }

  const supabaseAdmin = getSupabaseAdmin();
  let { data: rewards, error } = await supabaseAdmin
    .from("streamer_additional_gacha_rewards")
    .select("id, reward_id, reward_name, draw_count, is_raid_limited, created_at")
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
    }));
    error = fallbackResult.error;
  }

  if (error) {
    throw error;
  }

  return rewards || [];
}

/**
 * Issue #690: getOwnedStreamer の pg 直結実装。
 *
 * PostgREST 実装（下の getOwnedStreamer の postgrest 分岐）との対応:
 * - `.maybeSingle()` は streamers.twitch_user_id が UNIQUE 制約（migration
 *   00001）を持つため「0 行または 1 行」しか返り得ない。Drizzle 側は
 *   `.limit(1)` + `rows[0] ?? null` で同じ外部挙動にする
 *   （src/lib/twitch/token-manager.ts の getBotAccountForChatPg と同じ
 *   パターン）。
 * - isRaidStateSchemaError（PGRST204 or raid_gacha_active_until/
 *   raid_gacha_draw_count を含むメッセージ）に相当する「デプロイ窓
 *   フォールバック」を pg 版でも維持する。raid_gacha_draw_count は
 *   migration 00043 で追加された列であり、getAdditionalRewardsPg と同様の
 *   理由（本番適用済みならほぼ発火しないが、デプロイ窓フォールバック規約に
 *   準拠するため）で isPgMissingColumnError（42703）検知の縮退フォールバック
 *   を用意する。
 * - 発火条件の差について（厳格レビュー指摘・意図的な差）: pg 側は 42703
 *   （未定義列）のみで発火し、postgrest 側の isRaidStateSchemaError
 *   （PGRST204、または message に raid_gacha_active_until/raid_gacha_draw_count
 *   を含む任意エラー）より条件が厳密に狭い。支配的シナリオ（デプロイ窓での
 *   列欠落そのもの）では両者とも発火するため一致するが、PGRST204 は PostgREST の
 *   スキーマキャッシュ固有のエラーコードで pg 直結には存在しない概念であり、
 *   message 文字列一致による広い判定を pg 側にそのまま移植する意味がない。
 *   db/errors.ts の SQLSTATE ベース判定規約に沿ってこの差を意図的に許容している
 *   （getAdditionalRewardsPg と同じ判断）。
 * - フォールバック時は raid_gacha_draw_count: 0 を補完する（PostgREST 版と
 *   同じデフォルト値。streamers スキーマの DEFAULT 値とも一致）。
 * - 戻り値の外形（呼び出し側から見た挙動）を完全パリティで維持するため、
 *   PostgREST 版と同じ `{ streamer, error }` 形状で返す。PostgREST は
 *   `{ data, error }` を返す非例外スタイルだが、postgres.js は例外を throw
 *   するため、pg 版は try/catch で例外を捕捉し announcements.ts 等の既存
 *   パイロットパターンに倣って `{ streamer: null, error }` に写像する。
 *   呼び出し元（GET ハンドラ）は `if (streamerError) return
 *   handleDatabaseError(...)` という既存の分岐をそのまま使い続けられる
 *   （呼び出し側コードは 1 文字も変更していない）。
 */
async function getOwnedStreamerPg(twitchUserId: string): Promise<{
  streamer: { id: string; channel_point_reward_id: string | null; raid_gacha_draw_count: number } | null;
  error: unknown;
}> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            channel_point_reward_id: streamersTable.channel_point_reward_id,
            raid_gacha_draw_count: streamersTable.raid_gacha_draw_count,
          })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "getOwnedStreamer",
      { idempotent: true },
    );
    return { streamer: rows[0] ?? null, error: null };
  } catch (error) {
    if (!isPgMissingColumnError(error)) {
      // 既存パターン（announcements 等）に倣い、pg 経路の例外を { streamer, error }
      // 形状に写像する。呼び出し元は error があれば handleDatabaseError で
      // 500 を返す既存分岐をそのまま使う。
      return { streamer: null, error };
    }
    try {
      // デプロイ窓フォールバック（42703 undefined_column）: raid_gacha_draw_count
      // を含めない縮退クエリへ切り替え、PostgREST 版と同じデフォルト値
      // （raid_gacha_draw_count: 0）を補って返す。
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select({
              id: streamersTable.id,
              channel_point_reward_id: streamersTable.channel_point_reward_id,
            })
            .from(streamersTable)
            .where(eq(streamersTable.twitch_user_id, twitchUserId))
            .limit(1);
        },
        "getOwnedStreamer:raid-state-fallback",
        { idempotent: true },
      );
      const row = rows[0];
      return {
        streamer: row ? { ...row, raid_gacha_draw_count: 0 } : null,
        error: null,
      };
    } catch (fallbackError) {
      return { streamer: null, error: fallbackError };
    }
  }
}

async function getOwnedStreamer(twitchUserId: string) {
  // Issue #690 (#570 パイロット踏襲): DB_DRIVER=pg-read/pg のときのみ pg 直結の
  // getOwnedStreamerPg へ切り替える。フラグ未設定時（既定 'postgrest'）は以下の
  // 既存 supabase-js 実装がそのまま実行され、挙動は完全に不変。
  if (isPgReadEnabled()) {
    return getOwnedStreamerPg(twitchUserId);
  }

  const supabaseAdmin = getSupabaseAdmin();
  let { data: streamer, error } = await supabaseAdmin
    .from("streamers")
    .select("id, channel_point_reward_id, raid_gacha_draw_count")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (isRaidStateSchemaError(error)) {
    const fallbackResult = await supabaseAdmin
      .from("streamers")
      .select("id, channel_point_reward_id")
      .eq("twitch_user_id", twitchUserId)
      .maybeSingle();
    streamer = fallbackResult.data
      ? { ...fallbackResult.data, raid_gacha_draw_count: 0 }
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
    }

    return NextResponse.json(responsePayload);
  } catch (error) {
    return handleApiError(error, "Channel Point Bootstrap API");
  } finally {
    logPerf("api", "channel-point-bootstrap", startedAt, { diagnostics });
  }
}
