import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  validateCardName,
  validateImageUrl,
  validateRarity,
} from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { logger } from "@/lib/logger";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
import type { ApiRateLimitResponse } from "@/types/api";
import type { Rarity } from "@/types/database";
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。この POST は cards への一括 INSERT
// (書き込み)を含むため、streamer 所有権確認も含めたリクエスト内の全 DB
// アクセスを isPgWriteEnabled() で分岐する(読み書きで経路が混ざると障害切り
// 分けが困難になるため。battle/start route と同じ判断)。フラグ未設定時
// (既定 'postgrest')はこれらのモジュールの実行パスに一切入らないため、import
// が存在するだけでは挙動に影響しない(tests/setup.ts の getDb throw スタブが
// 「postgrest 経路で getDb が呼ばれない」ことを構造的に保証)。
// ---------------------------------------------------------------------------
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgWriteEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable, streamers as streamersTable } from "@/lib/db/schema";

/**
 * POST /api/cards/batch の streamer 所有権確認の pg 直結実装 (#663)。
 *
 * .eq("id", ...).eq("twitch_user_id", ...).maybeSingle() は streamers.id が PK
 * のため LIMIT 1 + rows[0] ?? null で同じ外部挙動。取得失敗は既存実装と同じく
 * 区別せず null 扱いにする(既存実装が `!streamer` だけで 403 判定しているため。
 * この select は rarity_weights/id のみで card_pack_names 等の新しい列を含まない
 * ため、列未デプロイのカスケードフォールバックは元々存在しない)。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchStreamerForBatchCreatePg(
  streamerId: string,
  twitchUserId: string
): Promise<{ id: string; rarity_weights: Record<string, number> | null } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id, rarity_weights: streamersTable.rarity_weights })
          .from(streamersTable)
          .where(and(eq(streamersTable.id, streamerId), eq(streamersTable.twitch_user_id, twitchUserId)))
          .limit(1);
      },
      "Cards Batch API: streamer ownership(pg)",
      { idempotent: true }
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * POST /api/cards/batch の cards 一括 INSERT の pg 直結実装 (#663)。
 *
 * .insert(cardsToInsert).select() は「挿入した全行の全列」を返すため、
 * Drizzle の .returning()(引数なし = 全列)が同じ外部挙動。この一括 INSERT は
 * card_number / max_issuance_count / collection_name を含まないため(cardsToInsert
 * の構築ロジック参照)、既存実装にも列未デプロイのカスケードフォールバックは
 * 存在せず、pg 版もそれをそのまま再現する(無い物を追加しない)。
 *
 * 冪等性判断(リトライ不可の根拠): POST /api/cards の insertCardPg と同じ理由
 * (一意制約・冪等キーの無い一般的な複数件同時作成)。接続断を自動リトライすると
 * カードの二重作成(最大50件が丸ごと重複)につながるため、非冪等(withDbRetry
 * 既定 = リトライなし)として扱う。
 */
async function insertCardsBatchPg(
  cardsToInsert: Array<Record<string, unknown>>
): Promise<{ data: Record<string, unknown>[] | null; error: unknown }> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db.insert(cardsTable).values(cardsToInsert as never[]).returning();
      },
      "Cards Batch API: insert cards(pg)"
      // 非冪等のため withDbRetry の第3引数(idempotent オプション)は渡さない
      // (既定 false = 接続断でもリトライしない。上記 doc コメント参照)
    );
    return { data: rows, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

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
    // #663: cards への一括 INSERT(書き込み)を含むハンドラのため、以降の全 DB
    // アクセスを usePgWrite で分岐する(ファイル冒頭のコメント参照)。判定は
    // ここで 1 回だけ行って固定し、リクエスト処理の途中で環境変数が変わっても
    // 経路が混在しないようにする(battle/start route と同じ設計)。
    const usePgWrite = isPgWriteEnabled();

    const supabaseAdmin = getSupabaseAdmin();
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
    const { data: streamer } = usePgWrite
      ? { data: await fetchStreamerForBatchCreatePg(streamerId, session.twitchUserId) }
      : await supabaseAdmin
          .from("streamers")
          .select("id, rarity_weights")
          .eq("id", streamerId)
          .eq("twitch_user_id", session.twitchUserId)
          .maybeSingle();

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
    const { data: createdCards, error } = usePgWrite
      ? await insertCardsBatchPg(cardsToInsert)
      : await supabaseAdmin
          .from("cards")
          .insert(cardsToInsert)
          .select();

    if (error) {
      return handleDatabaseError(error, "Cards Batch API: Failed to create cards");
    }

    // 再計算はベストエフォート: カード一括作成は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    try {
      recalculatedCards = await recalculateIfAutoMode(
        supabaseAdmin,
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
