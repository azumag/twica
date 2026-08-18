import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures, type Session } from "@/lib/session";

import { handleApiError, handleDatabaseError, recordApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { ADDITIONAL_SCOPES } from "@/lib/twitch/scopes";
import { TwitchTokenError, getTwitchAccessToken, hasScope, isPermanentRefreshFailure, twitchTokenErrorReportContext } from "@/lib/twitch/token-manager";
import {
  deriveEventSubStatus,
  type EventSubSubscriptionForStatus,
} from "@/lib/twitch/eventsub-status";
import { logPerf, perfStart } from "@/lib/perf";
import { logger } from "@/lib/logger.server";
import { fetchTwitchApi } from "@/lib/twitch/app-token";
// チャネルポイント連携の読み取りは PlanetScale の単一接続を使う。
// getDb() は withDbRetry の queryFn 内で取得する。
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { isPgMissingColumnError } from "@/lib/db/errors";
import {
  streamers as streamersTable,
  streamerAdditionalGachaRewards as streamerAdditionalGachaRewardsTable,
} from "@/lib/db/schema";
import {
  getChannelPointsAccessState,
  persistChannelPointsCapability,
  recordChannelPointsApiFailure,
} from "@/lib/twitch/channel-points-access";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

interface TwitchReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
}





interface TwitchRewardsResult {
  rewards: TwitchReward[];
  requiresReauth?: boolean;
  // Twitch APIが一時的に失敗した（429/5xx/その他非2xx）ことを示す。
  // #788: この場合は保存済みcapability確定状態を破壊しない。
  temporarilyUnavailable?: boolean;
  // 401/403を受けた場合のみ設定。呼び出し元がDB確定状態を同期するために使う。
  capabilitySyncStatus?: 401 | 403;
}

async function getTwitchRewards(twitchUserId: string): Promise<TwitchRewardsResult> {
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
    return { rewards: [], requiresReauth: true, capabilitySyncStatus: 401 };
  }

  // #788: 403を「Affiliateではない」固定文言(旧affiliateRequired契約)ではなく、
  // Capability状態ベースの契約へ置き換える。呼び出し元がDBのcapabilityを
  // unavailableへ同期する。
  if (response.status === 403) {
    return { rewards: [], capabilitySyncStatus: 403 };
  }

  if (!response.ok) {
    // 429/5xx等の一時失敗。DB確定状態は破壊しない。
    return { rewards: [], temporarilyUnavailable: true };
  }

  const data = await response.json();
  return { rewards: data.data || [] };
}

/**
 * Issue #1018: TwitchTokenErrorのうち「step-up再認証でしか回復しない
 * 恒久トークン失効」に該当するかを判定する。
 *
 * - NO_TOKEN: DBにrefresh可能なトークンが一切無い状態。現在の実装では
 *   getTwitchAccessTokenがnullを返すため到達しない防御的経路だが、
 *   将来throw方式へ戻っても同じ401契約になるようにここで集約する。
 * - REFRESH_FAILED かつ恒久失効: refreshがTwitchのtoken endpointから恒久
 *   エラー(invalid_grant・refresh token失効等の400/401/403)で拒否された
 *   ケース。判定は isPermanentRefreshFailure(token-manager.ts) に委譲し、
 *   kind='http' かつ status ∈ {400,401,403} のホワイトリストに絞る。
 *
 * 一過性の5xx(429/5xx、520/521/525/526/530等のCloudflare系を含む)、network
 * エラー、invalid_response、DB障害起因のrefresh失敗(diagnostic未付与)は再認証
 * で回復しないため対象外(false)とし、従来どおりhandleApiErrorの500を維持する。
 * これにより一時障害を恒久失効と誤判定してcapabilityをreauth_requiredへ
 * 誤確定させるのを防ぐ。
 */
function isReauthRequiredTokenError(error: unknown): boolean {
  if (!(error instanceof TwitchTokenError)) return false;
  if (error.code === "NO_TOKEN") return true;
  return isPermanentRefreshFailure(error);
}

async function getSubscriptionsByUserId(
  userId: string,
): Promise<EventSubSubscriptionForStatus[]> {
  const allData: EventSubSubscriptionForStatus[] = [];
  let cursor: string | undefined;

  do {
    const url = new URL(`${TWITCH_API_URL}/eventsub/subscriptions`);
    url.searchParams.set("user_id", userId);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);

    const response = await fetchTwitchApi(url.toString());

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
 * - フル select（id, reward_id, reward_name, draw_count, is_raid_limited,
 *   created_at）を streamer_id で絞り込み created_at 昇順に取得する。
 * - draw_count・is_raid_limited は migration 00041 で追加されたため、rolling
 *   deploy の短い窓だけ SQLSTATE 42703 を検知して縮退クエリへ切り替える。
 *   任意の message 文字列ではなく SQLSTATE を根拠にし、接続障害や権限エラーを
 *   migration 遅延として握りつぶさない。
 * - フォールバック時は draw_count: 1 / is_raid_limited: false を補完する
 *   （streamerAdditionalGachaRewards schema の DEFAULT 値と一致）。
 * - withDbRetry 内で発生した例外はそのまま伝播させる（呼び出し元の
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
  // 追加報酬は PlanetScale の単一接続から取得する。
  return getAdditionalRewardsPg(streamerId);
}

/**
 * Issue #690: getOwnedStreamer の pg 直結実装。
 *
 * - streamers.twitch_user_id は UNIQUE 制約（migration
 *   00001）を持つため「0 行または 1 行」しか返り得ない。Drizzle 側は
 *   `.limit(1)` + `rows[0] ?? null` で取得する
 *   （src/lib/twitch/token-manager.ts の getBotAccountForChatPg と同じ
 *   パターン）。
 * - raid_gacha_draw_count は migration 00043 で追加されたため、42703 の
 *   デプロイ窓だけ縮退し、raid_gacha_draw_count: 0 を補完する。
 * - postgres.js の例外は `{ streamer: null, error }` に写像する。
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
  // 所有者確認は PlanetScale の単一接続から取得する。
  return getOwnedStreamerPg(twitchUserId);
}

export async function GET(request: NextRequest) {
  const startedAt = perfStart();
  const diagnostics = request.nextUrl.searchParams.get("diagnostics") === "1";
  // Issue #1018: catch内で「ログイン済み配信者の恒久トークン失効か」を判定する
  // ためにtry外までsessionを保持する。getSession()自体の失敗は従来どおり
  // catchへ伝播し500になる。
  let session: Session | null = null;

  try {
    session = await getSession();
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
      const accessState = await getChannelPointsAccessState(session.twitchUserId);
      return NextResponse.json({
        hasRequiredScope: false,
        rewards: [],
        requiresReauth: true,
        capability: accessState?.capability ?? "unknown",
        capabilityCheckedAt: accessState?.checkedAt ?? null,
      });
    }

    const { rewards, requiresReauth, temporarilyUnavailable, capabilitySyncStatus } =
      await getTwitchRewards(session.twitchUserId);

    if (capabilitySyncStatus) {
      await recordChannelPointsApiFailure(session.twitchUserId, capabilitySyncStatus);
    }
    let accessState = await getChannelPointsAccessState(session.twitchUserId);

    // #788 子E #793 Fableレビュー Major-2: Twitch APIが実際に200で成功したにもかかわらず、
    // 保存済みcapabilityが古いunavailable/reauth_required/unknownのままだと、報酬一覧は
    // 正常に返るのにUIが「利用不可」エラーを表示し続けてしまう（オンボーディング完了後の
    // 自己回復手段が手動再判定しかない状態）。実際の200成功を根拠にavailableへ回復させる。
    // 既にavailableなら無駄な書き込みをしない。
    if (!capabilitySyncStatus && !requiresReauth && !temporarilyUnavailable && accessState?.capability !== "available") {
      // Fableレビュー Major-B: この自己回復はあくまで補助的な同期であり、
      // 失敗（デプロイ窓・maintenance中の書き込み不可等）してもTwitchから実際に
      // 取得できた報酬一覧を返すレスポンス自体を巻き込んではならない
      // （401/403同期のrecordChannelPointsApiFailureと同じ「握りつぶす」方針に揃える）。
      try {
        await persistChannelPointsCapability(session.twitchUserId, {
          capability: "available",
          reason: "ok",
          httpStatus: 200,
          definitive: true,
        });
        accessState = await getChannelPointsAccessState(session.twitchUserId);
      } catch (error) {
        logger.warn("Channel Point Bootstrap API: failed to self-heal capability to available (ignored)", {
          twitchUserId: session.twitchUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const responsePayload: Record<string, unknown> = {
      hasRequiredScope: true,
      rewards,
      requiresReauth,
      temporarilyUnavailable: temporarilyUnavailable === true,
      capability: accessState?.capability ?? "unknown",
      capabilityCheckedAt: accessState?.checkedAt ?? null,
    };

    if (diagnostics && !requiresReauth) {
      const { streamer, error: streamerError } = await getOwnedStreamer(session.twitchUserId);
      if (streamerError) return handleDatabaseError(streamerError, "Channel Point Bootstrap API");
      if (!streamer) return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });

      const subscriptions = await getSubscriptionsByUserId(session.twitchUserId);
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
    // Issue #1018: トークン恒久失効(REFRESH_FAILEDでrefreshRetryable === false /
    // NO_TOKEN)は汎用500ではなく401+requiresReauthを返す。rewards/emotesルートと
    // 同一のbody契約で、クライアント側(ChannelPointSettings)がstep-up再認証CTAを
    // 表示できる。エラー記録経路(recordApiError→errorsテーブル→auto-generated
    // bug report)は維持し、capability確定状態もreauth_requiredへ同期する
    // (recordChannelPointsApiFailureは内部で失敗を吸収するため応答に影響しない)。
    if (session && isReauthRequiredTokenError(error)) {
      await recordApiError(error, "Channel Point Bootstrap API", twitchTokenErrorReportContext(error));
      await recordChannelPointsApiFailure(session.twitchUserId, 401);
      return NextResponse.json(
        { error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED, requiresReauth: true },
        { status: 401 }
      );
    }
    // Issue #670: refresh失敗(REFRESH_FAILED)の場合、diagnostics(status/kind)を
    // auto-generated bug reportのContextへ載せる(twitchTokenErrorReportContext参照)。
    return handleApiError(error, "Channel Point Bootstrap API", twitchTokenErrorReportContext(error));
  } finally {
    logPerf("api", "channel-point-bootstrap", startedAt, { diagnostics });
  }
}
