import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";

import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { logger } from "@/lib/logger.server";
import {
  resolveCollectionNamesField,
  resolveEffectiveRewardPackNames,
  toLegacyCollectionName,
  findUnregisteredRewardPackName,
  DEFAULT_PACK_SENTINEL,
} from "@/lib/validation/collection-name";
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
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { getErrorChain, getSqlState, isPgMissingNamedColumnError } from "@/lib/db/errors";
import {
  streamers as streamersTable,
  streamerAdditionalGachaRewards as streamerAdditionalGachaRewardsTable,
  streamerAdditionalGachaRewardsWithPackNames as streamerAdditionalGachaRewardsWithPackNamesTable,
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
 * 含まれているだけで誤検知するため。詳細は src/lib/db/errors.ts の
 * isPgMissingNamedColumnError のコメント参照）。
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

// PUT 専用: draw_count / is_raid_limited 列未デプロイ窓の 503 文言。
// POST の RAID_OPTIONS_SCHEMA_PENDING_MESSAGE は「再度追加してください」で PUT の
// 文脈に合わないため、更新用の文言を分ける。
const PUT_RAID_OPTIONS_SCHEMA_PENDING_MESSAGE =
  "追加の引き換えのN連ガチャ設定がまだDBに反映されていません。少し待ってから再度お試しください。";

interface AdditionalRewardRow {
  id: string;
  reward_id: string;
  reward_name: string | null;
  draw_count: number;
  is_raid_limited: boolean;
  collection_name: string | null;
  // Issue #1994: 実効のパック割り当て（resolveEffectiveRewardPackNames 済み）。
  // collection_name は先頭要素のミラー（後方互換）。
  collection_names: string[];
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
 * 追加報酬の応答形状（GET の一覧・PUT の成功時 RETURNING）で使う明示列の共有定義。
 * 引数なし returning() はスキーマ全列（streamer_id 含む）を返すため使わず、
 * GET と PUT で streamer_id の有無を統一する。collection_name 未デプロイ窓用の
 * セット（collection_name なし）もここから派生させる。
 *
 * 命名注意: 同ファイルの selectMinimal（4列: id/reward_id/reward_name/created_at）
 * とは別物。こちらは「collection_name を除く応答6列」を指す。
 */
const ADDITIONAL_REWARD_COLUMNS_WITHOUT_COLLECTION_NAME = {
  id: streamerAdditionalGachaRewardsTable.id,
  reward_id: streamerAdditionalGachaRewardsTable.reward_id,
  reward_name: streamerAdditionalGachaRewardsTable.reward_name,
  draw_count: streamerAdditionalGachaRewardsTable.draw_count,
  is_raid_limited: streamerAdditionalGachaRewardsTable.is_raid_limited,
  created_at: streamerAdditionalGachaRewardsTable.created_at,
} as const;

const ADDITIONAL_REWARD_RESPONSE_COLUMNS = {
  ...ADDITIONAL_REWARD_COLUMNS_WITHOUT_COLLECTION_NAME,
  collection_name: streamerAdditionalGachaRewardsWithPackNamesTable.collection_name,
  // Issue #1994: 複数パック割り当て。応答には collection_names として解決済みの
  // 配列を載せる（下記 mapAdditionalRewardRow）。
  reward_pack_names: streamerAdditionalGachaRewardsWithPackNamesTable.reward_pack_names,
} as const;

/**
 * DB 行（collection_name + reward_pack_names）を API 応答形状
 * （collection_name + collection_names）へ変換する。collection_names は
 * resolveEffectiveRewardPackNames のフォールバック規則で解決し、DB 列
 * reward_pack_names 自体は応答に含めない（内部表現のため）。
 */
function mapAdditionalRewardRow(
  row: Omit<AdditionalRewardRow, "collection_names"> & { reward_pack_names?: unknown },
): AdditionalRewardRow {
  const { reward_pack_names, ...rest } = row;
  return {
    ...rest,
    collection_names: resolveEffectiveRewardPackNames(reward_pack_names, row.collection_name),
  };
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
          .select(ADDITIONAL_REWARD_RESPONSE_COLUMNS)
          .from(streamerAdditionalGachaRewardsWithPackNamesTable)
          .where(eq(streamerAdditionalGachaRewardsWithPackNamesTable.streamer_id, streamerId))
          .orderBy(asc(streamerAdditionalGachaRewardsWithPackNamesTable.created_at));
      },
      "Additional Rewards API: GET(full)",
      { idempotent: true },
    );

  const selectWithoutCollectionName = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select(ADDITIONAL_REWARD_COLUMNS_WITHOUT_COLLECTION_NAME)
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
    const rows = await selectFull();
    return rows.map((row) => mapAdditionalRewardRow(row));
  } catch (error) {
    // Issue #1994: reward_pack_names 列のみ未デプロイなら、新列を除く
    // collection_name ありの中間列セットで再試行し collection_names=[] 補完
    // （= 旧単一列だけで解決する）。collection_name 欠落フォールバックより先に
    // 判定する（列名の部分一致誤検知を避けるため、名前で厳密判定する）。
    if (isPgMissingNamedColumnError(error, ["reward_pack_names"])) {
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb();
            return db
              .select({
                ...ADDITIONAL_REWARD_COLUMNS_WITHOUT_COLLECTION_NAME,
                collection_name: streamerAdditionalGachaRewardsTable.collection_name,
              })
              .from(streamerAdditionalGachaRewardsTable)
              .where(eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId))
              .orderBy(asc(streamerAdditionalGachaRewardsTable.created_at));
          },
          "Additional Rewards API: GET(no reward_pack_names)",
          { idempotent: true },
        );
        return rows.map((row) => ({ ...row, collection_names: [] as string[] }));
      } catch (packNamesError) {
        // 中間列セットも失敗した場合は、従来の欠落チェインへ誤判定なく委ねる。
        if (isMissingCollectionNameColumn(packNamesError as GenericDbError)) {
          try {
            const rows = await selectWithoutCollectionName();
            return rows.map((row) => ({ ...row, collection_name: null, collection_names: [] as string[] }));
          } catch (error2) {
            if (isRaidOptionsSchemaErrorPg(error2)) {
              const rows = await selectMinimal();
              return rows.map((row) => ({ ...row, draw_count: 1, is_raid_limited: false, collection_name: null, collection_names: [] as string[] }));
            }
            throw error2;
          }
        }
        if (isRaidOptionsSchemaErrorPg(packNamesError)) {
          const rows = await selectMinimal();
          return rows.map((row) => ({ ...row, draw_count: 1, is_raid_limited: false, collection_name: null, collection_names: [] as string[] }));
        }
        throw packNamesError;
      }
    }
    if (isMissingCollectionNameColumn(error as GenericDbError)) {
      try {
        const rows = await selectWithoutCollectionName();
        return rows.map((row) => ({ ...row, collection_name: null, collection_names: [] as string[] }));
      } catch (error2) {
        if (isRaidOptionsSchemaErrorPg(error2)) {
          const rows = await selectMinimal();
          return rows.map((row) => ({ ...row, draw_count: 1, is_raid_limited: false, collection_name: null, collection_names: [] as string[] }));
        }
        throw error2;
      }
    }
    if (isRaidOptionsSchemaErrorPg(error)) {
      const rows = await selectMinimal();
      return rows.map((row) => ({ ...row, draw_count: 1, is_raid_limited: false, collection_name: null, collection_names: [] as string[] }));
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
    // Issue #1994: reward_pack_names 列のみ未デプロイなら新列だけ剥がし、
    // 旧単一列（先頭要素ミラー）への書き込みを続行する。collection_name の
    // 部分一致検知より先に判定する（列名の誤検知防止）。
    if (isPgMissingNamedColumnError(error, ["reward_pack_names"]) && "reward_pack_names" in insertPayload) {
      delete insertPayload.reward_pack_names;
      try {
        const rows = await runInsert(insertPayload);
        return { kind: "ok", reward: rows[0] ?? null };
      } catch (retryError) {
        return classifyError(retryError);
      }
    }
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

    // Issue #1994: optional multi-pack binding. 複数形 collectionNames（配列）
    // を正規とし、旧単一形 collectionName も受理する（併用は曖昧なので 400）。
    const collectionNamesResult = resolveCollectionNamesField(body, "collectionNames", "collectionName");
    if (!collectionNamesResult.ok) {
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
    // Issue #1994: membership 検証は全要素へ（DEFAULT_PACK_SENTINEL は
    // findUnregisteredRewardPackName 内部で免除）。POST は常に新規紐付けのため
    // 現在値は空配列を渡す。
    if (
      collectionNamesResult.value !== undefined &&
      !cardPackNamesUnavailable &&
      findUnregisteredRewardPackName(collectionNamesResult.value, [], registeredPackNames) !== null
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
    }

    // デプロイ窓でmembership検証ができない間は、新しいパック紐付けの書き込み
    // 自体を見送る(報酬自体の作成は続行)。
    const collectionNameSkippedDeployWindow =
      cardPackNamesUnavailable &&
      collectionNamesResult.value !== undefined &&
      collectionNamesResult.value.length > 0;

    // Issue #393: when a pack is bound, ensure it actually has active cards so the
    // reward never resolves to an empty draw pool at redemption time. Skip the
    // check during the deploy window (column not migrated yet) and when the
    // assignment could not be persisted anyway.
    // Issue #1994: 複数割り当てでは紐付く各パックへ同じ検査を行う。
    if (collectionNamesResult.value !== undefined && !collectionNameSkippedDeployWindow) {
      for (const name of collectionNamesResult.value) {
        const existence = await checkCollectionHasActiveCards(streamer.id, name);
        if (existence === "absent") {
          return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_FOUND }, { status: 400 });
        }
      }
    }

    // Insert the new additional reward
    // 新しい追加報酬を挿入
    // collection_name / reward_pack_names は値が指定された場合のみ含める。
    // 未指定の通常作成では列を含めないことで、列が未デプロイでも作成を壊さない。
    // Issue #1994: 両列を同じ INSERT で書き、旧列には先頭要素をミラーする。
    const insertPayload: Record<string, unknown> = {
      streamer_id: streamer.id,
      reward_id: rewardId,
      reward_name: rewardName || null,
      draw_count: normalizedDrawCount,
      is_raid_limited: isRaidLimited ?? false,
    };
    if (collectionNamesResult.value !== undefined && !collectionNameSkippedDeployWindow) {
      insertPayload.reward_pack_names = collectionNamesResult.value;
      insertPayload.collection_name = toLegacyCollectionName(collectionNamesResult.value);
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
// PUT: ownership lookup + update (read+write mixed → PlanetScale の単一接続)
// ---------------------------------------------------------------------------

/**
 * 更新対象の追加報酬の現在状態（collection_name）を取得する pg 実装。
 *
 * PUT は「登録解除済みパックの再送信（孤立参照の維持）」を許可する
 * （isRegisteredOrUnchanged の currentValue 判定）ため、更新前に現在値を
 * 読む必要がある。0 行なら null を返し、呼び出し元が 404 を返す。
 * collection_name 列未デプロイ窓では列を外して再試行し null を補完する。
 */
async function getAdditionalRewardForUpdatePg(
  streamerId: string,
  rewardId: string,
): Promise<{
  reward: { id: string; collection_name: string | null; reward_pack_names?: unknown } | null;
  collectionNameUnavailable: boolean;
  error: unknown;
}> {
  const selectWithCollectionName = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamerAdditionalGachaRewardsWithPackNamesTable.id,
            collection_name: streamerAdditionalGachaRewardsWithPackNamesTable.collection_name,
            reward_pack_names: streamerAdditionalGachaRewardsWithPackNamesTable.reward_pack_names,
          })
          .from(streamerAdditionalGachaRewardsWithPackNamesTable)
          .where(
            and(
              eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId),
              eq(streamerAdditionalGachaRewardsTable.reward_id, rewardId)
            )
          )
          .limit(1);
      },
      "Additional Rewards API: PUT lookup",
      { idempotent: true },
    );

  const selectWithoutCollectionName = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: streamerAdditionalGachaRewardsTable.id })
          .from(streamerAdditionalGachaRewardsTable)
          .where(
            and(
              eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId),
              eq(streamerAdditionalGachaRewardsTable.reward_id, rewardId)
            )
          )
          .limit(1);
      },
      "Additional Rewards API: PUT lookup (no collection_name)",
      { idempotent: true },
    );

  try {
    const rows = await selectWithCollectionName();
    return { reward: rows[0] ?? null, collectionNameUnavailable: false, error: null };
  } catch (error) {
    // Issue #1994: reward_pack_names 列のみ未デプロイなら新列だけ外して再試行し、
    // 旧単一列だけで現在値を解決する。collection_name 欠落より先に判定する。
    if (isPgMissingNamedColumnError(error, ["reward_pack_names"])) {
      try {
        const rows = await withDbRetry(
          async () => {
            const { db } = await getDb();
            return db
              .select({
                id: streamerAdditionalGachaRewardsTable.id,
                collection_name: streamerAdditionalGachaRewardsTable.collection_name,
              })
              .from(streamerAdditionalGachaRewardsTable)
              .where(
                and(
                  eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId),
                  eq(streamerAdditionalGachaRewardsTable.reward_id, rewardId)
                )
              )
              .limit(1);
          },
          "Additional Rewards API: PUT lookup (no reward_pack_names)",
          { idempotent: true },
        );
        return { reward: rows[0] ?? null, collectionNameUnavailable: false, error: null };
      } catch (packNamesError) {
        if (!isMissingCollectionNameColumn(packNamesError as GenericDbError)) {
          return { reward: null, collectionNameUnavailable: false, error: packNamesError };
        }
        // collection_name も無い場合は従来のフォールバックへ続行する。
      }
    }
    if (isMissingCollectionNameColumn(error as GenericDbError)) {
      try {
        const rows = await selectWithoutCollectionName();
        const row = rows[0] ?? null;
        return {
          reward: row ? { ...row, collection_name: null } : null,
          collectionNameUnavailable: true,
          error: null,
        };
      } catch (fallbackError) {
        return { reward: null, collectionNameUnavailable: true, error: fallbackError };
      }
    }
    return { reward: null, collectionNameUnavailable: false, error };
  }
}

type UpdateAdditionalRewardOutcome =
  // collectionNameStripped: collection_name 列未デプロイ窓で当該列を剥がして
  // 再試行した場合に true。パック変更が破棄されたことを呼び出し元へ伝え、
  // 応答に collectionNameSkippedDeployWindow として反映する（黙って破棄しない）。
  | { kind: "ok"; reward: unknown; collectionNameStripped?: boolean }
  | { kind: "not-found" }
  // lookup 後に collection_name が別リクエストで変わった場合の CAS 不一致。
  // 「削除済み」とは区別し、呼び出し元で 409 + 再取得へ誘導する。
  | { kind: "conflict" }
  // collection_name 列未デプロイ窓でパック変更のみの更新を送ると、ストリップ後に
  // 更新フィールドが空になる。空 SET は Drizzle が "No values to set" で throw する
  // ため、実行前に no-op へ分岐させる（500 にしない）。
  | { kind: "no-op"; collectionNameStripped?: boolean }
  // draw_count / is_raid_limited 列未デプロイ窓（POST と同じ 503 扱い）。
  | { kind: "raid-options-unavailable"; error: unknown }
  | { kind: "error"; error: unknown };

/**
 * 追加報酬の更新（collection_name / draw_count）を実行する pg 実装。
 *
 * POST の insertAdditionalRewardPg と同じく、collection_name 列未デプロイ窓では
 * 当該列を剥がして再試行する（それ以外の失敗は握りつぶさない）。
 * 通常スキーマでは collection_name の現在値を CAS 条件へ含め、0行更新を
 * concurrent conflict として検出する。collection_name 未デプロイ窓だけは
 * 当該列を参照できないため従来の streamer/reward 条件へ縮退し、0行を not-found とする。
 */
async function updateAdditionalRewardPg(
  streamerId: string,
  rewardId: string,
  updatePayload: Record<string, unknown>,
  expectedCollectionName?: string | null,
): Promise<UpdateAdditionalRewardOutcome> {
  // collection_name 列未デプロイ窓では RETURNING にも collection_name を含めない。
  // Drizzle の引数なし returning() はスキーマ定義の全列を明示列挙するため、
  // SET から外しても RETURNING 側で 42703 が再発する（レビュー指摘対応）。
  // 成功時の RETURNING は GET（listAdditionalRewardsPg の selectFull）と同じ
  // 明示列に揃え、API 全体で streamer_id の有無を統一する（streamer_id は返さない）。
  const runUpdate = (
    payload: Record<string, unknown>,
    returningMinimal: boolean,
    expectedCollectionNameForCas?: string | null,
  ) =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        const predicates = [
          eq(streamerAdditionalGachaRewardsTable.streamer_id, streamerId),
          eq(streamerAdditionalGachaRewardsTable.reward_id, rewardId),
        ];
        // lookup → membership 判定 → UPDATE の間で collection_name が変わると、
        // lookup 時点では「現在値と同じ」として許可した登録解除済みパックを
        // stale なリクエストが後から書き戻せる。通常スキーマでは現在値を
        // WHERE に含める compare-and-swap にし、その競合を0行更新として検出する。
        // collection_name 列未デプロイ窓はこの列自体を参照できないため CAS を外す。
        if (expectedCollectionNameForCas !== undefined) {
          predicates.push(
            expectedCollectionNameForCas === null
              ? isNull(streamerAdditionalGachaRewardsTable.collection_name)
              : eq(streamerAdditionalGachaRewardsTable.collection_name, expectedCollectionNameForCas),
          );
        }
        const query = db
          .update(streamerAdditionalGachaRewardsTable)
          .set(payload as typeof streamerAdditionalGachaRewardsTable.$inferInsert)
          .where(and(...predicates));
        const baseReturning = ADDITIONAL_REWARD_COLUMNS_WITHOUT_COLLECTION_NAME;
        return returningMinimal
          ? query.returning(baseReturning)
          : query.returning(ADDITIONAL_REWARD_RESPONSE_COLUMNS);
      },
      "Additional Rewards API: PUT update",
      {
        // CAS付きで collection_name を「別の値」へ変える更新は、初回COMMIT成功後に
        // 応答だけ失われると再試行時の CAS が0行になり、成功済みなのに409へ誤分類
        // し得る。そのためこのケースだけ接続断リトライを禁止する。
        // draw_countのみ・collection_name同値更新・列未デプロイ再試行は最終状態が
        // 同じで CAS 条件も維持されるため、従来どおり冪等リトライを許可する。
        idempotent: !(
          "collection_name" in payload &&
          expectedCollectionNameForCas !== undefined &&
          payload.collection_name !== expectedCollectionNameForCas
        ),
      },
    );

  // 空 SET を実行すると Drizzle が throw するため、実行前に空チェックで no-op へ分岐。
  // collectionNameStripped はストリップ後の再試行から引き継ぐ。
  // returningMinimal は列欠落窓からの再試行で常に true（成功時の RETURNING にも
  // collection_name が含まれるため、SET になくても 42703 が再発する）。
  // 初回は常に (false, false) で呼び、再試行だけがストリップ由来の値を渡す
  // （3 引数はすべて必須とし、引数の組み合わせ解釈を固定する）。
  const tryUpdate = async (
    payload: Record<string, unknown>,
    collectionNameStripped: boolean,
    returningMinimal: boolean,
    expectedCollectionNameForCas?: string | null,
  ): Promise<UpdateAdditionalRewardOutcome> => {
    if (Object.keys(payload).length === 0) return { kind: "no-op", collectionNameStripped };
    const rows = await runUpdate(payload, returningMinimal, expectedCollectionNameForCas);
    if (rows.length === 0) {
      return expectedCollectionNameForCas === undefined
        ? { kind: "not-found" }
        : { kind: "conflict" };
    }
    return { kind: "ok", reward: rows[0] ?? null, collectionNameStripped };
  };

  try {
    return await tryUpdate(updatePayload, false, false, expectedCollectionName);
  } catch (error) {
    // collection_name 列未デプロイ窓: 成功時の RETURNING に collection_name が
    // 含まれるため、SET が draw_count のみの更新でも 42703 になり得る。そのため
    // 「collection_name が SET にある」だけでなく、列欠落エラーそのもので
    // 再試行へ分岐する。
    // Issue #1994: reward_pack_names 列のみ未デプロイなら新列だけ剥がし、
    // 旧単一列（先頭要素ミラー）への書き込みを続行する。collection_name の
    // 部分一致検知より先に判定する。
    if (isPgMissingNamedColumnError(error, ["reward_pack_names"]) && "reward_pack_names" in updatePayload) {
      const stripped = { ...updatePayload };
      delete stripped.reward_pack_names;
      try {
        return await tryUpdate(stripped, true, true, expectedCollectionName);
      } catch (retryError) {
        if (isMissingCollectionNameColumn(retryError as GenericDbError)) {
          delete stripped.collection_name;
          try {
            return await tryUpdate(stripped, true, true, undefined);
          } catch (finalError) {
            return { kind: "error", error: finalError };
          }
        }
        if (isRaidOptionsSchemaErrorPg(retryError)) {
          return { kind: "raid-options-unavailable", error: retryError };
        }
        return { kind: "error", error: retryError };
      }
    }
    if (isMissingCollectionNameColumn(error as GenericDbError)) {
      // 呼び出し元の updatePayload をミューテートせず、コピーから剥がして再試行する
      // （同じオブジェクトを delete すると、呼び出し元のログ・テストが壊れる）。
      // ストリップフラグは「SET に collection_name があり、実際に剥がした」場合
      // だけ立て、drawCount のみの更新で「パック変更は反映待ち」と誤表示しない。
      const stripped = { ...updatePayload };
      const hadCollectionName = "collection_name" in stripped;
      delete stripped.collection_name;
      // Issue #1994: collection_name 欠落環境に reward_pack_names は無い
      // （新列は旧列より後発のため）が、仮に SET に残っていれば同時に剥がす。
      delete stripped.reward_pack_names;
      try {
        // collection_name 列欠落が確定した再試行では CAS 条件にも同列を使えない。
        return await tryUpdate(stripped, hadCollectionName, true, undefined);
      } catch (retryError) {
        if (isRaidOptionsSchemaErrorPg(retryError)) {
          return { kind: "raid-options-unavailable", error: retryError };
        }
        // ストリップ後の再試行が失敗した場合は、他分岐と同じ handleDatabaseError
        // （{ kind: "error" }）へ寄せて分類を揃える。
        return { kind: "error", error: retryError };
      }
    }
    // draw_count / is_raid_limited 列未デプロイ窓は POST と同じ 503 扱い
    // （接続断・権限エラーは isRaidOptionsSchemaErrorPg が除外するため握りつぶさない）。
    if (isRaidOptionsSchemaErrorPg(error)) {
      return { kind: "raid-options-unavailable", error };
    }
    return { kind: "error", error };
  }
}

/**
 * PUT: 追加報酬の設定（紐付くカードパック・排出枚数）を更新する。
 * 追加報酬は作成/削除のみだったため、グループの変更は「削除して作り直し」を
 * 強いていた。UI の編集操作からこのエンドポイントを呼び、既存の EventSub
 * サブスクリプション（報酬 ID ベース）を維持したまま設定だけを更新する。
 */
export async function PUT(request: NextRequest) {
  // Content-Type validation - must be the first check
  // JSON body を要求する状態変更 API のため POST と同じく最初に検証する。
  const contentTypeValidation = validateContentType(request, "application/json");
  if (contentTypeValidation) {
    return contentTypeValidation;
  }

  // 状態変更 API のため CSRF 検証を最初に行う (#736。DELETE と同一方針)。
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
    // body が null / 配列 / 非オブジェクトの場合は destructuring で TypeError に
    // なり 500 になるため、400 で拒否する（POST と同じ既存パターンの PUT 側対応）。
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }
    const { rewardId, drawCount } = body as Record<string, unknown>;

    // Issue #1994: optional multi-pack binding for this additional reward.
    // undefined = 変更なし、null/[] = 全カードへ戻す、配列 = パック和集合へ紐付け。
    // 旧単一形 collectionName も受理する（併用は曖昧なので 400）。
    const collectionNamesResult = resolveCollectionNamesField(body, "collectionNames", "collectionName");
    if (!collectionNamesResult.ok) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    // rewardId は後続の string 引数へ渡すため、ここで string へ narrowing する
    // （unknown のままでは typecheck が失敗する。レビュー指摘対応）。
    if (typeof rewardId !== "string" || rewardId.trim() === "") {
      return NextResponse.json({ error: ERROR_MESSAGES.MISSING_REWARD_ID }, { status: 400 });
    }

    // Issue #836: rewardId は Twitch の報酬 ID（UUID）形式を要求する（POST と同一）。
    if (!validateRewardId(rewardId).valid) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    // drawCount: true 等の非数値は Number() で 1 に化けるため、number 型を要求する
    // （POST と同じ既存挙動を見直した PUT 側の堅牢化）。
    if (drawCount !== undefined && typeof drawCount !== "number") {
      return NextResponse.json(
        { error: "drawCount must be an integer between 1 and 15" },
        { status: 400 }
      );
    }
    const normalizedDrawCount = drawCount;
    // Issue #641: upper bound raised from 10 to 15 (fixed limit, confirmed by owner).
    if (
      normalizedDrawCount !== undefined &&
      (!Number.isInteger(normalizedDrawCount) || normalizedDrawCount < 1 || normalizedDrawCount > 15)
    ) {
      return NextResponse.json(
        { error: "drawCount must be an integer between 1 and 15" },
        { status: 400 }
      );
    }

    // Get streamer info to verify ownership + registered pack catalog
    // ストリーマー情報を取得して所有権と登録済みパック名を確認
    const { streamer, cardPackNamesUnavailable } = await getStreamerForAdditionalRewardPost(
      session.twitchUserId
    );

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // 更新対象の現在値を読み、存在確認と「値が変わらない再送信」判定に使う。
    const currentResult = await getAdditionalRewardForUpdatePg(streamer.id, rewardId);
    if (currentResult.error) {
      return handleDatabaseError(currentResult.error, "Additional Rewards API: PUT lookup");
    }
    if (!currentResult.reward) {
      // 対象の追加報酬が存在しない（別タブ等で削除済み）。報酬不在を意味する
      // 専用文言を返す（STREAMER_NOT_FOUND は英語かつ実態と合わないため）。
      return NextResponse.json(
        { error: ERROR_MESSAGES.ADDITIONAL_REWARD_NOT_FOUND },
        { status: 404 }
      );
    }

    const registeredPackNames: string[] = Array.isArray(streamer.card_pack_names)
      ? streamer.card_pack_names
      : [];

    // Issue #1994: 現在の実効割り当て（配列列 + 旧列ミラーから解決）。
    const currentEffectiveNames = resolveEffectiveRewardPackNames(
      currentResult.reward.reward_pack_names,
      currentResult.reward.collection_name,
    );

    // Issue #393再設計: POST と同じ membership 検証。ただし PUT は既存紐付けの
    // 再送信（現在値と同一）も許可するため、現在の実効割り当て集合を
    // 「変更なし」の基準にする（孤立参照を壊さない）。
    // Issue #555: DEFAULT_PACK_SENTINEL は予約値のため membership 検証をスキップ
    // （findUnregisteredRewardPackName が内部で免除する）。
    if (
      collectionNamesResult.value !== undefined &&
      !cardPackNamesUnavailable &&
      findUnregisteredRewardPackName(
        collectionNamesResult.value,
        currentEffectiveNames,
        registeredPackNames
      ) !== null
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
    }

    const nextEffectiveNames = collectionNamesResult.value ?? currentEffectiveNames;
    const namesChanged =
      collectionNamesResult.value !== undefined &&
      (collectionNamesResult.value.length !== currentEffectiveNames.length ||
        collectionNamesResult.value.some((name, i) => name !== currentEffectiveNames[i]));

    // デプロイ窓で membership 検証ができない間は、新しいパック紐付けの書き込み
    // 自体を見送る（現在値の維持は続行。POST と同じ方針）。
    // 現在値と同じ割り当ての再送は「変更要求」ではないため対象外にし、
    // 「反映待ち」の誤表示を防ぐ。
    // センチネル（デフォルトパックのみ）と現在値維持の要素は登録不要のため、
    // 見送り対象は「新たに紐付く非センチネル要素がある」ときだけにする。
    const collectionNameSkippedDeployWindow =
      cardPackNamesUnavailable &&
      namesChanged &&
      nextEffectiveNames.some(
        (name) => name !== DEFAULT_PACK_SENTINEL && !currentEffectiveNames.includes(name),
      );

    // Issue #393: 紐付け先が変わる場合のみ、アクティブカードの存在を確認する
    // （空プールになる紐付けは拒否。POST と同じ #1 方針）。
    // Issue #1994: 複数割り当てでは「新たに紐付く各パック」へ同じ検査を行う。
    if (namesChanged && !collectionNameSkippedDeployWindow) {
      for (const name of nextEffectiveNames) {
        if (!currentEffectiveNames.includes(name)) {
          const existence = await checkCollectionHasActiveCards(streamer.id, name);
          if (existence === "absent") {
            return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_FOUND }, { status: 400 });
          }
        }
      }
    }

    // 更新するフィールドを構築。collection_name / reward_pack_names は値が
    // 指定された場合のみ含め、列未デプロイ窓でも更新自体を壊さない
    // （POST と同じ方針）。両列を同じ UPDATE で書き、旧列には先頭要素をミラーする。
    const updatePayload: Record<string, unknown> = {};
    if (collectionNamesResult.value !== undefined && !collectionNameSkippedDeployWindow) {
      updatePayload.reward_pack_names = collectionNamesResult.value;
      updatePayload.collection_name = toLegacyCollectionName(collectionNamesResult.value);
    }
    if (normalizedDrawCount !== undefined) {
      updatePayload.draw_count = normalizedDrawCount;
    }

    if (Object.keys(updatePayload).length === 0) {
      // 変更なしのリクエスト。更新自体は無意味なので現状維持として返す。
      // reward は含めない（成功時は DB 行全体、ここは取得していない列もある
      // ため形が揃わない。クライアントは応答本文を使わず再取得する）。
      // card_pack_names 列未デプロイ窓でパック変更のみを送るとここへ来るため、
      // パック変更が破棄されたことをフラグで明示する（他の分岐と対称）。
      return NextResponse.json({
        success: true,
        unchanged: true,
        ...(collectionNameSkippedDeployWindow ? { collectionNameSkippedDeployWindow: true } : {}),
      });
    }

    const updateOutcome = await updateAdditionalRewardPg(
      streamer.id,
      rewardId,
      updatePayload,
      // collection_name を実際に書く更新だけ CAS 対象にする。
      // drawCount-only や deploy-window で pack 書き込みを見送った更新は、
      // 同時に pack が変わっても直交する変更なので不要な409にしない。
      "collection_name" in updatePayload && !currentResult.collectionNameUnavailable
        ? currentResult.reward.collection_name
        : undefined,
    );

    if (updateOutcome.kind === "not-found") {
      // collection_name 列未デプロイ窓で CAS を使えない場合に、lookup 後の削除が
      // 起きると到達し得る。通常スキーマの concurrent mutation は下の conflict。
      return NextResponse.json(
        { error: ERROR_MESSAGES.ADDITIONAL_REWARD_NOT_FOUND },
        { status: 404 }
      );
    }

    if (updateOutcome.kind === "conflict") {
      return NextResponse.json(
        { error: ERROR_MESSAGES.ADDITIONAL_REWARD_CONCURRENT_UPDATE },
        { status: 409 }
      );
    }

    if (updateOutcome.kind === "no-op") {
      // collection_name 列未デプロイ窓でパック変更のみの更新が破棄された場合。
      // 成功扱いにしつつ、ストリップが起きたことを応答で明示する（黙って破棄しない）。
      // unchanged は「DB は変わっていない」ことを他の分岐と対称に伝える。
      return NextResponse.json({
        success: true,
        unchanged: true,
        ...(updateOutcome.collectionNameStripped || collectionNameSkippedDeployWindow
          ? { collectionNameSkippedDeployWindow: true }
          : {}),
      });
    }

    if (updateOutcome.kind === "raid-options-unavailable") {
      const errForLog = updateOutcome.error as { message?: string } | null | undefined;
      logger.warn("Additional reward raid options schema is not ready; refusing to update draws", {
        rewardId,
        streamerId: streamer.id,
        error: errForLog?.message,
      });
      return NextResponse.json(
        { error: PUT_RAID_OPTIONS_SCHEMA_PENDING_MESSAGE },
        { status: 503 }
      );
    }

    if (updateOutcome.kind === "error") {
      return handleDatabaseError(updateOutcome.error, "Additional Rewards API: PUT");
    }

    // 実際に永続化された列をログに出す（ストリップ時は collection_name を
    // 書いていないため除外し、障害調査時の誤誘導を防ぐ）。
    const writtenFields = updateOutcome.collectionNameStripped
      ? Object.keys(updatePayload).filter((key) => key !== "collection_name")
      : Object.keys(updatePayload);
    logger.info(
      `Additional reward updated: streamerId=${streamer.id}, rewardId=${rewardId}, fields=${writtenFields.join(",")}`
    );

    return NextResponse.json({
      success: true,
      reward: updateOutcome.reward,
      // card_pack_names 列欠落（既存）または collection_name 列欠落（ストリップ）の
      // どちらでも、パック変更が反映されなかったことを応答で明示する。
      ...((updateOutcome.collectionNameStripped || collectionNameSkippedDeployWindow)
        ? { collectionNameSkippedDeployWindow: true }
        : {}),
    });
  } catch (error) {
    return handleApiError(error, "Additional Rewards API: PUT");
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
