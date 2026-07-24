import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";

import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { recalculateIfAutoMode, executeBatchUpdateCardDropRatesRpcPg } from "@/lib/recalculate-drop-rates";
import { logger } from "@/lib/logger.server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable, streamers as streamersTable } from "@/lib/db/schema";
import { CARDS_SAFE_COLUMNS } from "@/lib/db/cards-safe-columns";
import type { ApiRateLimitResponse } from "@/types/api";

/**
 * Drop rate update data for batch processing
 * バッチ処理用のドロップレート更新データ
 */
interface DropRateUpdate {
  id: string;
  dropRate: number;
  intraRarityWeight?: number;
}

interface StreamerForBatchUpdate {
  id: string;
  rarity_weights: Record<string, number> | null;
}

/**
 * Issue #794: 旧全体ドライバーフラグ=pg のとき、所有権確認も更新RPCと同じPlanetScaleで行う。
 * pg経路も取得失敗時はnullを返して外部挙動を揃える。
 */
async function fetchStreamerForBatchUpdatePg(
  streamerId: string,
  twitchUserId: string
): Promise<StreamerForBatchUpdate | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            rarity_weights: streamersTable.rarity_weights,
          })
          .from(streamersTable)
          .where(
            and(
              eq(streamersTable.id, streamerId),
              eq(streamersTable.twitch_user_id, twitchUserId)
            )
          )
          .limit(1);
      },
      "Cards Batch Update API: streamer ownership check(pg)",
      { idempotent: true }
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Issue #794: 更新対象カードの存在確認もPlanetScale上の同じスナップショットで行う。
 */
async function fetchExistingCardsForBatchUpdatePg(
  streamerId: string,
  cardIds: string[]
): Promise<Array<{ id: string }> | null> {
  try {
    return await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: cardsTable.id })
          .from(cardsTable)
          .where(
            and(
              eq(cardsTable.streamer_id, streamerId),
              inArray(cardsTable.id, cardIds)
            )
          );
      },
      "Cards Batch Update API: existing cards check(pg)",
      { idempotent: true }
    );
  } catch {
    return null;
  }
}

/**
 * Issue #794: 更新後レスポンスもPlanetScaleから取得する。
 * 無指定selectは本番未デプロイ列を要求しうるためCARDS_SAFE_COLUMNSを使う。
 */
async function fetchUpdatedCardsForBatchUpdatePg(
  streamerId: string,
  cardIds: string[]
) {
  return withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select(CARDS_SAFE_COLUMNS)
        .from(cardsTable)
        .where(
          and(
            eq(cardsTable.streamer_id, streamerId),
            inArray(cardsTable.id, cardIds)
          )
        );
    },
    "Cards Batch Update API: fetch updated cards(pg)",
    { idempotent: true }
  );
}

/**
 * POST /api/cards/batch-update
 * Updates drop_rate for multiple cards at once
 * 複数カードのdrop_rateを一括更新
 *
 * Request body:
 * {
 *   streamerId: string,
 *   updates: Array<{ id: string, dropRate: number }>
 * }
 */
export async function POST(request: NextRequest) {
  // Content-Type validation - must be the first check
  // Content-Type検証 - 最初にチェック
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) {
    return contentTypeValidation
  }

  // CSRF token validation
  // CSRFトークン検証
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  const session = await getSession();

  // Rate limiting check
  // レート制限チェック
  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsPost, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      {
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000)
      },
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': String(rateLimitResult.limit),
          'X-RateLimit-Remaining': String(rateLimitResult.remaining),
          'X-RateLimit-Reset': String(rateLimitResult.reset),
        },
      }
    );
  }

  // Authentication and authorization check
  // 認証・認可チェック
  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { streamerId, updates } = body as { streamerId: string; updates: DropRateUpdate[] };

    // Validate request structure
    // リクエスト構造の検証
    if (!streamerId || !Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.MISSING_REQUIRED_FIELDS },
        { status: 400 }
      );
    }

    // Limit batch size to prevent abuse
    // 乱用防止のためバッチサイズを制限
    const MAX_BATCH_SIZE = 100;
    if (updates.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `一度に更新できるカードは${MAX_BATCH_SIZE}枚までです` },
        { status: 400 }
      );
    }

    // Verify streamer owns this streamer profile
    // 配信者がこのstreamerプロフィールを所有しているか確認
    const streamer = await fetchStreamerForBatchUpdatePg(streamerId, session.twitchUserId);

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Validate each update item
    // 各更新項目を検証
    const validationErrors: string[] = [];
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];

      if (!update.id || typeof update.id !== "string") {
        validationErrors.push(`更新${i + 1}: カードIDが無効です`);
        continue;
      }

      if (typeof update.dropRate !== "number" || update.dropRate < 0 || update.dropRate > 1) {
        validationErrors.push(`更新${i + 1}: ${ERROR_MESSAGES.DROP_RATE_INVALID}`);
      }

      if (update.intraRarityWeight !== undefined) {
        if (typeof update.intraRarityWeight !== "number" || !Number.isFinite(update.intraRarityWeight) || update.intraRarityWeight <= 0) {
          validationErrors.push(`更新${i + 1}: ${ERROR_MESSAGES.INTRA_RARITY_WEIGHT_INVALID}`);
        }
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json(
        { error: validationErrors.join("; ") },
        { status: 400 }
      );
    }

    // 同一IDが複数含まれると、RPC関数のROW_COUNTと期待件数が不一致になり
    // 誤って「部分更新」と判定されるため、重複を事前に排除
    const cardIds = updates.map(u => u.id);
    const uniqueCardIds = new Set(cardIds);
    if (uniqueCardIds.size !== cardIds.length) {
      return NextResponse.json(
        { error: "同じカードIDが複数含まれています" },
        { status: 400 }
      );
    }

    const existingCards = await fetchExistingCardsForBatchUpdatePg(streamerId, cardIds);

    if (!existingCards || existingCards.length !== cardIds.length) {
      return NextResponse.json(
        { error: "一部のカードが見つからないか、アクセス権がありません" },
        { status: 403 }
      );
    }

    // RPC関数を使って全カードのdrop_rateを1回のDB呼び出しで一括更新
    // 従来は各カードごとに個別のSupabase UPDATE（=個別のHTTP fetch）を発行していたが、
    // Cloudflare Workersのサブリクエスト上限（50回/リクエスト）を超過するため、
    // PostgreSQLストアドプロシージャで1リクエストに集約
    const rpcPayload = updates.map(u => {
                                     const payload: Record<string, unknown> = { id: u.id, drop_rate: u.dropRate };
      if (u.intraRarityWeight !== undefined) {
        payload.intra_rarity_weight = u.intraRarityWeight;
      }
      return payload;
    });
    // 正規化は recalculate-drop-rates.ts の executeBatchUpdateCardDropRatesRpcPg を
    // 共有する(同じ RPC を呼ぶ実装を2箇所に重複させない。doc コメント参照)。
    const { data: rpcResult, error: rpcError } =
      await executeBatchUpdateCardDropRatesRpcPg(streamerId, rpcPayload);

    if (rpcError) {
      return handleDatabaseError(rpcError, "Cards Batch Update API: Failed to update cards");
    }

    // RPC関数が返す更新件数と期待件数を照合し、一部のカードが更新されなかった場合を検出
    const updatedCount = rpcResult?.updated_count ?? 0;
    if (updatedCount !== updates.length) {
      return handleDatabaseError(
        { message: `Expected ${updates.length} updates but only ${updatedCount} succeeded`, details: "", hint: "", code: "" },
        "Cards Batch Update API: Partial update detected"
      );
    }

    // intra_rarity_weight変更がある場合、自動再計算を実行
    // 再計算はベストエフォート: バッチ更新は成功しているため、再計算失敗でも500を返さない
    const hasIntraWeightChanges = updates.some(u => u.intraRarityWeight !== undefined);
    let recalculatedCards = null;
    if (hasIntraWeightChanges && streamer.rarity_weights) {
      try {
        recalculatedCards = await recalculateIfAutoMode(
          streamerId,
          streamer.rarity_weights
        );
      } catch (recalculationError) {
        logger.error("Cards Batch Update API: Recalculation failed after intra-weight update", recalculationError);
      }
    }

    // 更新後のカードデータを取得して返す
    // 再計算済みの場合はそちらを優先
    let updatedCards;
    try {
      updatedCards = await fetchUpdatedCardsForBatchUpdatePg(streamerId, cardIds);
    } catch (fetchError) {
      return handleDatabaseError(fetchError, "Cards Batch Update API: Failed to fetch updated cards");
    }

    return NextResponse.json({
      success: true,
      updated: updates.length,
      cards: updatedCards,
      recalculatedCards,
    });
  } catch (error) {
    return handleApiError(error, "Cards Batch Update API: POST");
  }
}
