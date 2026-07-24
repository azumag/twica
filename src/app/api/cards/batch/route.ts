import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";

import {
  validateCardName,
  validateImageUrl,
  validateRarity,
} from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { logger } from "@/lib/logger.server";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
// -----------------------------------------------------------------------------
// #663 (#570/#572 パイロット踏襲): pg 直結経路。POST は読み取り（所有権確認）と
// 書き込み（一括 INSERT）が混在するため、DB アクセス部分は isPgWriteEnabled()
// で分岐する（token-manager.ts の getBotAccountForChat と同じ方針）。既存
// supabase-js 実装は 1 文字も変えず、フラグ未設定時（既定 'postgrest'）は
// 完全に従来どおり動く。フォールバックチェーンは無い（postgrest 経路も無い）。
// -----------------------------------------------------------------------------
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { Rarity } from "@/types/database";

import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable, streamers as streamersTable } from "@/lib/db/schema";
import { CARDS_SAFE_COLUMNS, isMissingCardsBattleColumnError } from "@/lib/db/cards-safe-columns";
import type { ApiRateLimitResponse } from "@/types/api";


/**
 * Card data for batch creation
 * 一括作成用のカードデータ
 */
interface BatchCardInput {
  name: string;
  imageUrl: string;
  rarity: Rarity;
  dropRate: number;
  description?: string;
  intraRarityWeight?: number;
}

/**
 * POST /api/cards/batch の streamer 所有権確認 (id, rarity_weights) の
 * pg 直結実装 (#663)。フォールバックチェーンは無い(postgrest 経路にも無い)。
 *
 * PostgREST 実装との対応:
 * - postgrest 経路は `data` のみ分割代入し error を確認しない
 *   （`const { data: streamer } = await ...`）ため、いかなるエラーも `!streamer`
 *   の 403 分岐に落ちる。pg 版も同じ外部挙動に合わせ、throw せず null を返す。
 */
async function selectStreamerForBatchCreatePg(
  streamerId: string,
  twitchUserId: string
): Promise<{ id: string; rarity_weights: Record<string, number> | null } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id, rarity_weights: streamersTable.rarity_weights })
          .from(streamersTable)
          .where(and(eq(streamersTable.id, streamerId), eq(streamersTable.twitch_user_id, twitchUserId)))
          .limit(1);
      },
      "Cards Batch API: streamer ownership check",
      { idempotent: true }
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /api/cards/batch の一括 INSERT の pg 直結実装 (#663)。
 * 入力値のデプロイ窓フォールバックチェーンは無い(postgrest 経路にも無い。
 * cardsToInsert は card_number/hp/atk 等の本番未デプロイ列を最初から
 * 含めない)。
 *
 * PostgREST 実装との対応:
 * - `.insert(cardsToInsert).select()` は `.insert(...).values(...).returning()`
 *   が等価（RETURNING で挿入行を1回の往復で取得）。
 * - ON CONFLICT の無い一括 INSERT のため非冪等（withDbRetry にオプションを
 *   渡さない = リトライなし。二重作成を避けるため）。
 *
 * self-review fix: 無指定 `.returning()` は schema.ts の静的列リストを生成する
 * ため、本番に実在しない8列(card_number/hp/atk/def/spd/skill_*、
 * cards-safe-columns.ts参照)を含む RETURNING は必ず失敗する。cardsToInsert
 * 自体はこれらの列を含まないため INSERT の VALUES 自体は成功しうるが、
 * RETURNING が無関係にそれらを要求するため失敗する。検知したら RETURNING を
 * CARDS_SAFE_COLUMNS（8列除外）へ切り替えて一度だけ再試行する。
 */
async function insertCardsBatchPg(
  cardsToInsert: Record<string, unknown>[]
): Promise<{ createdCards: Record<string, unknown>[] | null; error: unknown }> {
  async function attemptInsert(
    useSafeReturning = false
  ): Promise<{ createdCards: Record<string, unknown>[] | null; error: unknown }> {
    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          const query = db.insert(cardsTable).values(cardsToInsert as (typeof cardsTable.$inferInsert)[]);
          return useSafeReturning ? query.returning(CARDS_SAFE_COLUMNS) : query.returning();
        },
        "Cards Batch API: bulk insert cards"
        // ON CONFLICT の無い INSERT は再実行で二重作成になりうるため非冪等（既定 = リトライなし）
      );
      return { createdCards: rows, error: null };
    } catch (error) {
      return { createdCards: null, error };
    }
  }

  let { createdCards, error } = await attemptInsert();
  if (error && isMissingCardsBattleColumnError(error)) {
    ({ createdCards, error } = await attemptInsert(true));
  }
  return { createdCards, error };
}

/**
 * POST /api/cards/batch
 * Creates multiple cards at once (e.g., from Twitch emotes)
 * 複数のカードを一度に作成（例：Twitchエモートから）
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
    const { streamerId, cards } = body as { streamerId: string; cards: BatchCardInput[] };

    // Validate request structure
    // リクエスト構造の検証
    if (!streamerId || !Array.isArray(cards) || cards.length === 0) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.MISSING_REQUIRED_FIELDS },
        { status: 400 }
      );
    }

    // Limit batch size to prevent abuse
    // 乱用防止のためバッチサイズを制限
    const MAX_BATCH_SIZE = 50;
    if (cards.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `一度に作成できるカードは${MAX_BATCH_SIZE}枚までです` },
        { status: 400 }
      );
    }

    // Verify streamer owns this streamer profile
    // 配信者がこのstreamerプロフィールを所有しているか確認
    const streamer = await selectStreamerForBatchCreatePg(streamerId, session.twitchUserId);

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Validate each card
    // 各カードを検証
    const validationErrors: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];

      const nameValidation = validateCardName(card.name);
      if (!nameValidation.valid) {
        validationErrors.push(`カード${i + 1}: ${nameValidation.error}`);
        continue;
      }

      const imageUrlValidation = validateImageUrl(card.imageUrl);
      if (!imageUrlValidation.valid) {
        validationErrors.push(`カード${i + 1}: ${imageUrlValidation.error}`);
        continue;
      }

      const rarityValidation = validateRarity(card.rarity);
      if (!rarityValidation.valid) {
        validationErrors.push(`カード${i + 1}: ${rarityValidation.error}`);
        continue;
      }

      if (typeof card.dropRate !== "number" || card.dropRate < 0 || card.dropRate > 1) {
        validationErrors.push(`カード${i + 1}: ${ERROR_MESSAGES.DROP_RATE_INVALID}`);
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json(
        { error: validationErrors.join("; ") },
        { status: 400 }
      );
    }

    // Prepare cards for insertion
    // 挿入用にカードを準備
    const cardsToInsert = cards.map((card) => {
                                      const row: Record<string, unknown> = {
        streamer_id: streamerId,
        name: card.name,
        description: card.description || "",
        image_url: card.imageUrl,
        rarity: card.rarity,
        drop_rate: card.dropRate,
      };
      if (card.intraRarityWeight !== undefined && Number.isFinite(card.intraRarityWeight) && card.intraRarityWeight > 0) {
        row.intra_rarity_weight = card.intraRarityWeight;
      }
      return row;
    });

    // Insert all cards at once
    // 全カードを一度に挿入
    const { createdCards, error } = await insertCardsBatchPg(cardsToInsert);

    if (error) {
      return handleDatabaseError(error, "Cards Batch API: Failed to create cards");
    }

    // 再計算はベストエフォート: カード一括作成は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    try {
      recalculatedCards = await recalculateIfAutoMode(
        streamerId,
        streamer.rarity_weights
      );
    } catch (recalculationError) {
      logger.error("Cards Batch API: Recalculation failed after batch creation", recalculationError);
    }

    return NextResponse.json({
      success: true,
      created: createdCards?.length || 0,
      cards: createdCards,
      recalculatedCards,
    });
  } catch (error) {
    return handleApiError(error, "Cards Batch API: POST");
  }
}
