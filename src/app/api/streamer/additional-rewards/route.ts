import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";

import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { logger } from "@/lib/logger.server";
import { resolveCollectionNameField, isRegisteredOrUnchanged, DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import { validateRewardId, validateRewardName } from "@/lib/validations";
import {
  checkCollectionHasActiveCards,
  isMissingCollectionNameColumn,
  isMissingCardPackNamesColumnError,
} from "@/lib/collections/collection-existence";
// -----------------------------------------------------------------------------
// GET、POST、DELETE の DB アクセスはすべて PlanetScale の単一接続を使う。
// 接続は withDbRetry の queryFn 内で取得し、リトライ時に新しいクライアントを使う。
// -----------------------------------------------------------------------------
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { getErrorChain, getSqlState } from "@/lib/db/errors";
import {
  streamers as streamersTable,
  streamerAdditionalGachaRewards as streamerAdditionalGachaRewardsTable,
} from "@/lib/db/schema";

type GenericDbError = { message?: string; code?: string; details?: string; hint?: string } | null | undefined;

/**
 * PlanetScale経路（listAdditionalRewardsPg / insertAdditionalRewardPg）の
 * raid-options（draw_count/is_raid_limited）列未デプロイ検知
 * (Fable厳格レビュー指摘・中3)。
 *
 * Drizzle にラップされた DrizzleQueryError.message は実行 SQL 文そのもので、
 * このテーブルへの SELECT/INSERT は常に draw_count 列を含む。そのため原因を
 * 問わず（接続断・制約違反等でも）あらゆるエラーが schema-pending と誤判定され、
 * draw_count=1/is_raid_limited=false へ静かに縮退してしまう
 * (channel-point-bootstrap/route.ts の getAdditionalRewardsPg が
 * isPgMissingColumnError で厳密化しているのと同じ理由)。
 *
 * ここでは SQLSTATE 42703 (undefined_column) **かつ** 対象列名を含む、という
 * より厳密な条件にする。getErrorChain の各階層を独立に評価する（中4対応:
 * 全階層を連結したテキストで判定すると、無関係な階層の SQL 文に列名が偶然
 * 含まれているだけで誤検知するため。詳細は collection-existence.ts /
 * cards-safe-columns.ts のコメント参照）。
 */
function isRaidOptionsSchemaErrorPg(error: unknown): boolean {
  return getErrorChain(error).some((layer) => {
    if (typeof layer !== "object" || layer === null) return false;
    const err = layer as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    if (err.code !== "42703") return false;
    const text = [err.message, err.details, err.hint].map((value) => String(value ?? "")).join(" ");
    return text.includes("draw_count") || text.includes("is_raid_limited");
  });
}

const RAID_OPTIONS_SCHEMA_PENDING_MESSAGE =
  "追加の引き換えのN連ガチャ設定がまだDBに反映されていません。少し待ってから再度追加してください。";

interface AdditionalRewardRow {
  id: string;
  reward_id: string;
  reward_name: string | null;
  draw_count: number;
  is_raid_limited: boolean;
  collection_name: string | null;
  created_at: string | null;
}

// ---------------------------------------------------------------------------
// GET: ownership lookup + reward listing (read-only → PlanetScale の単一接続)
// ---------------------------------------------------------------------------

async function getOwnedStreamerIdForRewardsPg(twitchUserId: string): Promise<string | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "Additional Rewards API: ownership lookup",
      { idempotent: true },
    );
    return rows[0]?.id ?? null;
  } catch {
    // ため、失敗時は data=undefined と同じ「not found」扱いに揃える。
    return null;
  }
}

async function getOwnedStreamerIdForRewards(twitchUserId: string): Promise<string | null> {
  // #663: 読み取り専用のため PlanetScale の単一接続を使用。
  return getOwnedStreamerIdForRewardsPg(twitchUserId);

}

/**
 * listAdditionalRewardsPg の各列セレクトと 2 段フォールバックチェイン (#663)
 *
 * collection_name 列欠落を raid-options 列欠落より先に判定する。raid 側の
 * フォールバックは draw_count/is_raid_limited を巻き込んで初期化するため、
 * collection_name
 * 側のフォールバック取得がさらに raid 列欠落で失敗した場合は、そのままより
 * 少ない列セット（最終フォールバック）へ続けてカスケードする。
 */
async function listAdditionalRewardsPg(streamerId: string): Promise<AdditionalRewardRow[]> {
  const selectFull = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamerAdditionalGachaRewardsTable.id,
            reward_id: streamerAdditionalGachaRewardsTable.reward_id,
            reward_name: streamerAdditionalGachaRewardsTable.reward_name,
            draw_count: streamerAdditionalGachaRewardsTable.draw_count,
            is_raid_limited: streamerAdditionalGachaRewardsTable.is_raid_limited,
            collection_name: streamerAdditionalGachaRewardsTable.collection_name,
            created_at: streamerAdditionalGachaRewardsTable.created_at,
          })
          .from(streamerAdditionalGachaRewardsTable)
          .where(eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId))
          .orderBy(asc(streamerAdditionalGachaRewardsTable.created_at));
      },
      "Additional Rewards API: GET(full)",
      { idempotent: true },
    );

  const selectWithoutCollectionName = () =>
    withDbRetry(
      async () => {
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
      "Additional Rewards API: GET(no collection_name)",
      { idempotent: true },
    );

  const selectMinimal = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamerAdditionalGachaRewardsTable.id,
            reward_id: streamerAdditionalGachaRewardsTable.reward_id,
            reward_name: streamerAdditionalGachaRewardsTable.reward_name,
            created_at: streamerAdditionalGachaRewardsTable.created_at,
          })
          .from(streamerAdditionalGachaRewardsTable)
          .where(eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId))
          .orderBy(asc(streamerAdditionalGachaRewardsTable.created_at));
      },
      "Additional Rewards API: GET(minimal)",
      { idempotent: true },
    );

  try {
    return await selectFull();
  } catch (error) {
    if (isMissingCollectionNameColumn(error as GenericDbError)) {
      try {
        const rows = await selectWithoutCollectionName();
        return rows.map((row) => ({ ...row, collection_name: null }));
      } catch (error2) {
        if (isRaidOptionsSchemaErrorPg(error2)) {
          const rows = await selectMinimal();
          return rows.map((row) => ({ ...row, draw_count: 1, is_raid_limited: false, collection_name: null }));
        }
        throw error2;
      }
    }
    if (isRaidOptionsSchemaErrorPg(error)) {
      const rows = await selectMinimal();
      return rows.map((row) => ({ ...row, draw_count: 1, is_raid_limited: false, collection_name: null }));
    }
    throw error;
  }
}



async function listAdditionalRewards(streamerId: string): Promise<AdditionalRewardRow[]> {
  // #663: 読み取り専用のため PlanetScale の単一接続を使用。
  return listAdditionalRewardsPg(streamerId);

}

/**
 * GET: ストリーマーの追加報酬一覧を取得
 * Fetch additional gacha rewards for the current streamer
 */
export async function GET(request: NextRequest) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

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
    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    const streamerId = await getOwnedStreamerIdForRewards(session.twitchUserId);

    if (!streamerId) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    let rewards: AdditionalRewardRow[];
    try {
      rewards = await listAdditionalRewards(streamerId);
    } catch (error) {
      return handleDatabaseError(error, "Additional Rewards API: GET");
    }

    // キャッシュを無効化して、削除後も常に最新のデータを返す
    // Disable caching to ensure fresh data is returned after deletions
    return NextResponse.json(rewards || [], {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    return handleApiError(error, "Additional Rewards API: GET");
  }
}

// ---------------------------------------------------------------------------
// POST: ownership lookup + insert (read+write mixed → PlanetScale の単一接続)
// ---------------------------------------------------------------------------

interface StreamerForAdditionalRewardPost {
  id: string;
  channel_point_reward_id: string | null;
  card_pack_names: string[];
}

interface GetStreamerForAdditionalRewardPostResult {
  streamer: StreamerForAdditionalRewardPost | null;
  cardPackNamesUnavailable: boolean;
}

async function getStreamerForAdditionalRewardPostPg(
  twitchUserId: string
): Promise<GetStreamerForAdditionalRewardPostResult> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            channel_point_reward_id: streamersTable.channel_point_reward_id,
            card_pack_names: streamersTable.card_pack_names,
          })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "Additional Rewards API: POST ownership lookup",
      { idempotent: true },
    );
    return { streamer: rows[0] ?? null, cardPackNamesUnavailable: false };
  } catch (error) {
    if (isMissingCardPackNamesColumnError(error as GenericDbError)) {
      try {
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
          "Additional Rewards API: POST ownership lookup (no card_pack_names)",
          { idempotent: true },
        );
        const row = rows[0] ?? null;
        return {
          streamer: row ? { ...row, card_pack_names: [] as string[] } : null,
          cardPackNamesUnavailable: true,
        };
      } catch {
        // 揃える(この SELECT はエラーを 500 化しない既存の swallow パターン)。
        return { streamer: null, cardPackNamesUnavailable: true };
      }
    }
    return { streamer: null, cardPackNamesUnavailable: false };
  }
}

async function getStreamerForAdditionalRewardPost(
  twitchUserId: string
): Promise<GetStreamerForAdditionalRewardPostResult> {
  // #663: 読み書き混在(このあと INSERT する)のため PlanetScale の単一接続を使用。
  return getStreamerForAdditionalRewardPostPg(twitchUserId);
}

type InsertAdditionalRewardOutcome =
  | { kind: "ok"; reward: unknown }
  | { kind: "raid-options-unavailable"; error: unknown }
  | { kind: "conflict" }
  | { kind: "error"; error: unknown };

async function insertAdditionalRewardPg(
  insertPayload: Record<string, unknown>
): Promise<InsertAdditionalRewardOutcome> {
  const runInsert = (payload: Record<string, unknown>) =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .insert(streamerAdditionalGachaRewardsTable)
          .values(payload as typeof streamerAdditionalGachaRewardsTable.$inferInsert)
          .returning();
      },
      "Additional Rewards API: POST insert",
      // ON CONFLICT の無い新規行 INSERT のため非冪等（既定 = リトライなし）
    );

  const classifyError = (error: unknown): InsertAdditionalRewardOutcome => {
                          if (isRaidOptionsSchemaErrorPg(error)) {
      return { kind: "raid-options-unavailable", error };
    }
    // getSqlState でチェーン（トップレベル→cause）全体から SQLSTATE を拾う
    // (Fable厳格レビュー指摘・高2)。Drizzle にラップされたエラーはトップレベルに
    // code を持たないため、旧実装のトップレベルのみの参照だと重複挿入
    // (UNIQUE(streamer_id, reward_id) 違反)が常に { kind: "error" }（500）に
    // 分類され、本来返すべき 409 conflict にならなかった。
    if (getSqlState(error) === "23505") {
      return { kind: "conflict" };
    }
    return { kind: "error", error };
  };

  try {
    const rows = await runInsert(insertPayload);
    return { kind: "ok", reward: rows[0] ?? null };
  } catch (error) {
    // Issue #393: deploy-window safety. Strip collection_name and retry if the
    // column is not migrated yet. Must run BEFORE the raid-options check because
    // both match the same generic missing-column shape; otherwise we would
    // return a misleading 503.
    if (isMissingCollectionNameColumn(error as GenericDbError) && "collection_name" in insertPayload) {
      delete insertPayload.collection_name;
      try {
        const rows = await runInsert(insertPayload);
        return { kind: "ok", reward: rows[0] ?? null };
      } catch (retryError) {
        return classifyError(retryError);
      }
    }
    return classifyError(error);
  }
}

async function insertAdditionalReward(
  insertPayload: Record<string, unknown>
): Promise<InsertAdditionalRewardOutcome> {
  // #663: 読み書き混在のため PlanetScale の単一接続を使用。
  return insertAdditionalRewardPg(insertPayload);
}

/**
 * POST: 新しい追加報酬を登録
 * Register a new additional gacha reward
 */
export async function POST(request: NextRequest) {
  // Content-Type validation - must be the first check
  const contentTypeValidation = validateContentType(request, "application/json");
  if (contentTypeValidation) {
    return contentTypeValidation;
  }

  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    );
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

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
    const { rewardId, rewardName, drawCount, isRaidLimited } = body;

    // Issue #393: optional pack binding for this additional reward.
    const collectionNameResult = resolveCollectionNameField(body, "collectionName");
    if (!collectionNameResult.ok) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    if (!rewardId) {
      return NextResponse.json({ error: ERROR_MESSAGES.MISSING_REWARD_ID }, { status: 400 });
    }

    // Issue #836: rewardId は Twitch の報酬 ID（UUID）形式を要求する。
    // 非 UUID が保存されると EventSub 購読条件（condition.reward_id）と不整合を起こす。
    if (!validateRewardId(rewardId).valid) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    // rewardName は文字列 + 長さ上限 + 制御文字禁止（null は許可）。
    if (!validateRewardName(rewardName).valid) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    const normalizedDrawCount = drawCount === undefined ? 1 : Number(drawCount);
    // Issue #641: upper bound raised from 10 to 15 (fixed limit, confirmed by owner).
    if (!Number.isInteger(normalizedDrawCount) || normalizedDrawCount < 1 || normalizedDrawCount > 15) {
      return NextResponse.json(
        { error: "drawCount must be an integer between 1 and 15" },
        { status: 400 }
      );
    }

    if (isRaidLimited !== undefined && typeof isRaidLimited !== "boolean") {
      return NextResponse.json(
        { error: "isRaidLimited must be a boolean" },
        { status: 400 }
      );
    }

    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    const { streamer, cardPackNamesUnavailable } = await getStreamerForAdditionalRewardPost(
      session.twitchUserId
    );

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Check if main reward is set (additional rewards require main reward to be configured first)
    // メイン報酬が設定されているか確認（追加報酬はメイン報酬設定後のみ追加可能）
    if (!streamer.channel_point_reward_id) {
      return NextResponse.json(
        { error: "メインの引き換えを先に設定してください" },
        { status: 400 }
      );
    }

    // Check if the reward is already the main reward
    // メイン報酬と同じIDでないか確認
    if (streamer.channel_point_reward_id === rewardId) {
      return NextResponse.json(
        { error: "このチャネルポイント引き換えはメインの引き換えとして既に設定されています" },
        { status: 400 }
      );
    }

    // Issue #393再設計: 追加報酬に更新エンドポイントは無い(作成/削除のみ)ため、
    // 非null値は常に「新規紐付け」として扱い、事前登録済みパック名であることを
    // 要求する(Issue #269のプレミアムゲートは廃止。パック管理モーダルでの
    // 追加時のみゲートする設計に変更したため、ここではmembership検証のみ行う)。
    const registeredPackNames: string[] = Array.isArray(streamer.card_pack_names)
      ? streamer.card_pack_names
      : [];
    // Issue #555: DEFAULT_PACK_SENTINEL is a reserved value that can never be a
    // member of card_pack_names (isReservedCollectionName rejects registering
    // it), so the ordinary membership check would always reject it. Every
    // streamer implicitly has this pseudo-pack (their unclassified cards), so
    // membership validation is skipped for it entirely; existence is verified
    // separately below via checkCollectionHasActiveCards.
    if (
      typeof collectionNameResult.value === "string" &&
      collectionNameResult.value !== DEFAULT_PACK_SENTINEL &&
      !cardPackNamesUnavailable &&
      !isRegisteredOrUnchanged(collectionNameResult.value, null, registeredPackNames)
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
    }

    // デプロイ窓でmembership検証ができない間は、新しいパック紐付けの書き込み
    // 自体を見送る(報酬自体の作成は続行)。
    const collectionNameSkippedDeployWindow =
      cardPackNamesUnavailable && typeof collectionNameResult.value === "string";

    // Issue #393: when a pack is bound, ensure it actually has active cards so the
    // reward never resolves to an empty draw pool at redemption time. Skip the
    // check during the deploy window (column not migrated yet) and when the
    // assignment could not be persisted anyway.
    if (typeof collectionNameResult.value === "string" && !collectionNameSkippedDeployWindow) {
      const existence = await checkCollectionHasActiveCards(
        streamer.id,
        collectionNameResult.value
      );
      if (existence === "absent") {
        return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_FOUND }, { status: 400 });
      }
    }

    // Insert the new additional reward
    // 新しい追加報酬を挿入
    // collection_name は値が指定された場合のみ含める。未指定/null の通常作成では
    // 列を含めないことで、collection_name 列が未デプロイでも作成を壊さない。
    const insertPayload: Record<string, unknown> = {
      streamer_id: streamer.id,
      reward_id: rewardId,
      reward_name: rewardName || null,
      draw_count: normalizedDrawCount,
      is_raid_limited: isRaidLimited ?? false,
    };
    if (typeof collectionNameResult.value === "string" && !collectionNameSkippedDeployWindow) {
      insertPayload.collection_name = collectionNameResult.value;
    }

    const insertOutcome = await insertAdditionalReward(insertPayload);

    if (insertOutcome.kind === "raid-options-unavailable") {
      const errForLog = insertOutcome.error as { message?: string } | null | undefined;
      logger.warn("Additional reward options schema is not ready; refusing to create a 1-draw fallback reward", {
        rewardId,
        streamerId: streamer.id,
        requestedDrawCount: normalizedDrawCount,
        error: errForLog?.message,
      });
      return NextResponse.json(
        { error: RAID_OPTIONS_SCHEMA_PENDING_MESSAGE },
        { status: 503 }
      );
    }

    if (insertOutcome.kind === "conflict") {
      return NextResponse.json(
        { error: "このチャネルポイント引き換えは既に追加されています" },
        { status: 409 }
      );
    }

    if (insertOutcome.kind === "error") {
      return handleDatabaseError(insertOutcome.error, "Additional Rewards API: POST");
    }

    const newReward = insertOutcome.reward;

    logger.info(
      `Additional reward registered: streamerId=${streamer.id}, rewardId=${rewardId}, rewardName=${rewardName}, drawCount=${normalizedDrawCount}, raidLimited=${isRaidLimited ?? false}`
    );

    return NextResponse.json({
      success: true,
      reward: newReward,
      ...(collectionNameSkippedDeployWindow ? { collectionNameSkippedDeployWindow: true } : {}),
    });
  } catch (error) {
    return handleApiError(error, "Additional Rewards API: POST");
  }
}

// ---------------------------------------------------------------------------
// DELETE: ownership lookup + delete (read+write mixed → PlanetScale の単一接続)
// ---------------------------------------------------------------------------

async function getOwnedStreamerIdForRewardsWritePg(twitchUserId: string): Promise<string | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "Additional Rewards API: DELETE ownership lookup",
      { idempotent: true },
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

interface DeleteAllAdditionalRewardsResult {
  error: unknown;
  deletedCount: number | null;
}

async function deleteAllAdditionalRewardsPg(streamerId: string): Promise<DeleteAllAdditionalRewardsResult> {
  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .delete(streamerAdditionalGachaRewardsTable)
          .where(eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId));
      },
      "Additional Rewards API: DELETE ALL",
      // フィルタ指定の DELETE は再実行しても最終状態が同じ（2回目は0行削除）ため冪等
      { idempotent: true },
    );
    // 公開APIの既存契約は deletedCount=null。削除対象のIDを返す必要はないため
    // RETURNING を付けず、不要な結果ペイロードとメモリ使用を避ける。
    return { error: null, deletedCount: null };
  } catch (error) {
    return { error, deletedCount: null };
  }
}

async function deleteAdditionalRewardByIdPg(streamerId: string, rewardId: string): Promise<{ error: unknown }> {
  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .delete(streamerAdditionalGachaRewardsTable)
          .where(
            and(
              eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId),
              eq(streamerAdditionalGachaRewardsTable.reward_id, rewardId)
            )
          );
      },
      "Additional Rewards API: DELETE",
      { idempotent: true },
    );
    return { error: null };
  } catch (error) {
    return { error };
  }
}

/**
 * DELETE: 追加報酬を削除
 * Delete additional gacha reward(s)
 * - ?rewardId=xxx: Delete specific reward
 * - ?deleteAll=true: Delete all additional rewards for the streamer
 */
export async function DELETE(request: NextRequest) {
  // 状態変更 API のため CSRF 検証を最初に行う (#736)。POST には既に存在するが
  // DELETE ハンドラだけ検証漏れがあった。
  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    );
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.streamerSettings, identifier);

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
    const url = new URL(request.url);
    const rewardId = url.searchParams.get("rewardId");
    const deleteAll = url.searchParams.get("deleteAll") === "true";

    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    const streamerId = await getOwnedStreamerIdForRewardsWritePg(session.twitchUserId);

    if (!streamerId) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    if (deleteAll) {
      // Delete all additional rewards for this streamer
      // このストリーマーの全ての追加報酬を削除
      const { error, deletedCount } = await deleteAllAdditionalRewardsPg(streamerId);
      if (error) {
        return handleDatabaseError(error, "Additional Rewards API: DELETE ALL");
      }
      logger.info(
        `All additional rewards deleted: streamerId=${streamerId}, count=${deletedCount}`
      );
      return NextResponse.json({ success: true, deletedCount });
    } else if (rewardId) {
      // Delete specific reward
      // 特定の報酬を削除
      const { error } = await deleteAdditionalRewardByIdPg(streamerId, rewardId);
      if (error) {
        return handleDatabaseError(error, "Additional Rewards API: DELETE");
      }
      logger.info(
        `Additional reward deleted: streamerId=${streamerId}, rewardId=${rewardId}`
      );
      return NextResponse.json({ success: true });
    } else {
      return NextResponse.json(
        { error: "rewardId または deleteAll パラメータが必要です" },
        { status: 400 }
      );
    }
  } catch (error) {
    return handleApiError(error, "Additional Rewards API: DELETE");
  }
}
