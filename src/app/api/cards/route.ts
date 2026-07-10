import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  validateCardName,
  validateCardDescription,
  validateImageUrl,
  validateRarity,
} from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { normalizeDropRate } from "@/lib/card-utils";
import { getStorageUsage } from "@/lib/storage-usage";
import { sha256Prefix } from "@/lib/crypto-utils";
import { logger } from "@/lib/logger";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
import { CARD_NUMBER_MESSAGES, isCardNumberConflictError, isMissingCardNumberColumnError } from "@/lib/card-number-errors";
import { CARD_ISSUANCE_MESSAGES, isMissingCardIssuanceColumnError, parseCardIssuanceLimit } from "@/lib/card-issuance";
import { resolveCollectionNameField, isRegisteredOrUnchanged } from "@/lib/validation/collection-name";
import { isMissingCollectionNameColumn, isMissingCardPackNamesColumnError } from "@/lib/collections/collection-existence";
import type { ApiRateLimitResponse } from "@/types/api";
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。POST は cards への INSERT(書き込み)を
// 含むため、streamer 所有権確認も含めたリクエスト内の全 DB アクセスを
// isPgWriteEnabled() で分岐する(読み書きで経路が混ざると障害切り分けが困難に
// なるため。battle/start route と同じ判断)。GET は読み取り専用のため
// isPgReadEnabled() で分岐する(pg-read でも切替)。
// フラグ未設定時(既定 'postgrest')はこれらのモジュールの実行パスに一切入らない
// ため、import が存在するだけでは挙動に影響しない(tests/setup.ts の getDb throw
// スタブが「postgrest 経路で getDb が呼ばれない」ことを構造的に保証)。
// ---------------------------------------------------------------------------
import { and, eq, inArray, count as sqlCount, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled, isPgWriteEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { isPgMissingColumnError } from "@/lib/db/errors";
import { cards as cardsTable, streamers as streamersTable, userCards as userCardsTable } from "@/lib/db/schema";

// Cache TTL for cards list (30 seconds to balance freshness and CPU usage)
// カード一覧のキャッシュTTL（新鮮さとCPU使用量のバランスで30秒）
const CARDS_CACHE_TTL = 30;

/**
 * POST /api/cards の streamer 所有権確認 + card_pack_names(事前登録パック一覧)
 * 取得の pg 直結実装 (#663)。
 *
 * PostgREST 実装との対応:
 * - .eq("id", ...).eq("twitch_user_id", ...).maybeSingle() は streamers.id が
 *   PK のため LIMIT 1 + rows[0] ?? null で同じ外部挙動。
 * - card_pack_names 列未デプロイ(42703)時は既存実装と同じく列を落として再試行し、
 *   cardPackNamesUnavailable=true で呼び出し元にフォールバックを伝える。
 *   isMissingCardPackNamesColumnError の pg 版として isPgMissingColumnError を使う
 *   (postgres.js の PostgresError は `details` ではなく `detail` を持つが、既存の
 *   isMissingCardPackNamesColumnError は message 文字列一致でも成立するため、
 *   ここでは SQLSTATE 42703 で直接判定する方が確実)。
 * - 列未デプロイ以外のエラーは既存 postgrest 経路と同じく区別せず streamer=null
 *   扱いにする(既存実装が `!streamer` だけで 403 判定しているため。エラー種別を
 *   問わず「取得できなければ403」という既存の緩い判定に合わせる)。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchStreamerForCardCreatePg(
  streamerId: string,
  twitchUserId: string
): Promise<{
  streamer: { id: string; rarity_weights: Record<string, number> | null; card_pack_names: string[] } | null;
  cardPackNamesUnavailable: boolean;
}> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            rarity_weights: streamersTable.rarity_weights,
            card_pack_names: streamersTable.card_pack_names,
          })
          .from(streamersTable)
          .where(and(eq(streamersTable.id, streamerId), eq(streamersTable.twitch_user_id, twitchUserId)))
          .limit(1);
      },
      "Cards API: POST streamer ownership(pg)",
      { idempotent: true }
    );
    const row = rows[0] ?? null;
    return {
      streamer: row ? { id: row.id, rarity_weights: row.rarity_weights, card_pack_names: row.card_pack_names ?? [] } : null,
      cardPackNamesUnavailable: false,
    };
  } catch (error) {
    if (!isPgMissingColumnError(error)) {
      return { streamer: null, cardPackNamesUnavailable: false };
    }
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
        "Cards API: POST streamer ownership fallback(pg)",
        { idempotent: true }
      );
      const row = rows[0] ?? null;
      return {
        streamer: row ? { id: row.id, rarity_weights: row.rarity_weights, card_pack_names: [] } : null,
        cardPackNamesUnavailable: true,
      };
    } catch {
      return { streamer: null, cardPackNamesUnavailable: true };
    }
  }
}

/**
 * POST /api/cards の cards INSERT の pg 直結実装 (#663)。
 *
 * PostgREST 実装との対応:
 * - .insert(insertData).select().maybeSingle() は「挿入行の全列を返す」ため、
 *   Drizzle の .returning()(引数なし = 全列)+ rows[0] ?? null が同じ外部挙動。
 * - card_number / max_issuance_count / collection_name 列の未デプロイ時カスケード
 *   リトライは、既存実装と同じ判定関数(isMissingCardNumberColumnError /
 *   isMissingCardIssuanceColumnError / isMissingCollectionNameColumn)をそのまま
 *   再利用する。これらは message 文字列の部分一致で判定しており、postgres.js が
 *   ネイティブに投げる 42703("column ... does not exist")のメッセージにも
 *   同じ列名 + "column"/"does not exist" が含まれるため、PostgREST 固有の
 *   PGRST204 判定と共存させても両ドライバで機能する(postgres.js の PostgresError
 *   は `details` ではなく `detail` を持つが、判定に必要な情報は message 自体に
 *   含まれるため影響しない)。card_number 一意制約違反(23505)も
 *   isCardNumberConflictError で同様に検知できる。
 * - 既存実装は各 if を独立に順次評価する(else if ではない)ため、この関数も同じ
 *   順序(card_number → max_issuance_count → collection_name)で 1 回ずつ再試行する
 *   カスケードを再現する。
 *
 * 冪等性判断(リトライ不可の根拠 — 重要): このカード作成 INSERT には一意制約
 * (card_number 重複時のみ)以外に冪等キーが無い一般的な新規作成であり、接続断は
 * 「クエリがサーバーに到達しコミット済みかどうか不明」を意味する。自動リトライ
 * すると同一カードの二重作成(在庫の実質的な水増し・発行枚数上限のすり抜け)に
 * つながるため、非冪等(withDbRetry 既定 = リトライなし)として扱う。
 */
async function insertCardPg(
  insertData: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; error: unknown }> {
  const data = { ...insertData };
  let result: Record<string, unknown> | null = null;
  let lastError: unknown = null;

  const tryInsert = async (): Promise<void> => {
    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db.insert(cardsTable).values(data as never).returning();
        },
        "Cards API: POST insert card(pg)"
        // 非冪等のため withDbRetry の第3引数(idempotent オプション)は渡さない
        // (既定 false = 接続断でもリトライしない。上記 doc コメント参照)
      );
      result = rows[0] ?? null;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
  };

  await tryInsert();

  if (lastError && isMissingCardNumberColumnError(lastError)) {
    delete data.card_number;
    await tryInsert();
  }
  if (lastError && isMissingCardIssuanceColumnError(lastError)) {
    delete data.max_issuance_count;
    await tryInsert();
  }
  if (lastError && isMissingCollectionNameColumn(lastError as { message?: string; code?: string; hint?: string }) && "collection_name" in data) {
    delete data.collection_name;
    await tryInsert();
  }

  return { data: result, error: lastError };
}

export async function POST(request: NextRequest) {
  // Content-Type validation - must be the first check
  const contentTypeValidation = validateContentType(request, 'application/json')
  if (contentTypeValidation) {
    return contentTypeValidation
  }

  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  const session = await getSession();

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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    // プランダウングレード等でストレージ超過中の場合、新規カード作成を拒否
    // 画像を含むカード作成時に、更なるストレージ消費を防止する
    const userPrefix = await sha256Prefix(session.twitchUserId);
    const storageUsage = await getStorageUsage(userPrefix, session.twitchUserId);
    if (storageUsage.planOverLimit) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.PLAN_OVER_LIMIT },
        { status: 507 }
      );
    }

    // #663: cards への INSERT(書き込み)を含むハンドラのため、以降の全 DB アクセスを
    // usePgWrite で分岐する(ファイル冒頭のコメント参照)。判定はここで 1 回だけ
    // 行って固定し、リクエスト処理の途中で環境変数が変わっても経路が混在しない
    // ようにする(battle/start route と同じ設計)。
    const usePgWrite = isPgWriteEnabled();

    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { streamerId, name, description, imageUrl, rarity, dropRate, intraRarityWeight, cardNumber, maxIssuanceCount } = body;

    // Issue #393: optional card pack name. Centralized helper distinguishes
    // "omitted" from "present-but-invalid" so bad types are rejected, not ignored.
    const collectionNameResult = resolveCollectionNameField(body, "collectionName");
    if (!collectionNameResult.ok) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    const nameValidation = validateCardName(name)
    if (!nameValidation.valid) {
      return NextResponse.json(
        { error: nameValidation.error },
        { status: 400 }
      )
    }

    const descriptionValidation = validateCardDescription(description)
    if (!descriptionValidation.valid) {
      return NextResponse.json(
        { error: descriptionValidation.error },
        { status: 400 }
      )
    }

    const imageUrlValidation = validateImageUrl(imageUrl)
    if (!imageUrlValidation.valid) {
      return NextResponse.json(
        { error: imageUrlValidation.error },
        { status: 400 }
      )
    }

    const rarityValidation = validateRarity(rarity)
    if (!rarityValidation.valid) {
      return NextResponse.json(
        { error: rarityValidation.error },
        { status: 400 }
      )
    }

    if (typeof dropRate !== "number" || dropRate < 0 || dropRate > 1) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.DROP_RATE_INVALID },
        { status: 400 }
      );
    }

    if (
      cardNumber !== undefined &&
      cardNumber !== null &&
      (!Number.isInteger(cardNumber) || cardNumber <= 0)
    ) {
      return NextResponse.json(
        { error: CARD_NUMBER_MESSAGES.invalid },
        { status: 400 }
      );
    }

    const parsedIssuanceLimit = parseCardIssuanceLimit(maxIssuanceCount);
    if (parsedIssuanceLimit === "invalid") {
      return NextResponse.json(
        { error: CARD_ISSUANCE_MESSAGES.invalid },
        { status: 400 }
      );
    }

    // intraRarityWeight は省略可能（デフォルト1.0）。指定時は正の数値のみ
    if (intraRarityWeight !== undefined) {
      if (typeof intraRarityWeight !== "number" || !Number.isFinite(intraRarityWeight) || intraRarityWeight <= 0) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.INTRA_RARITY_WEIGHT_INVALID },
          { status: 400 }
        );
      }
    }

    // Verify streamer owns this streamer profile
    //
    // #663: pg 経路(usePgWrite)では fetchStreamerForCardCreatePg に委譲する。
    // postgrest 経路は既存実装のまま(内側の変数名のみ streamer → streamerData に
    // 変更。if/else 分岐の外側で共有する streamer 変数とのシャドーイングを避ける
    // ための構造上の都合であり、クエリ・条件分岐ロジックは無変更)。
    let streamer: { id: string; rarity_weights: Record<string, number> | null; card_pack_names: string[] } | null;
    let cardPackNamesUnavailable = false;

    if (usePgWrite) {
      const result = await fetchStreamerForCardCreatePg(streamerId, session.twitchUserId);
      streamer = result.streamer;
      cardPackNamesUnavailable = result.cardPackNamesUnavailable;
    } else {
      let { data: streamerData, error: streamerSelectError } = await supabaseAdmin
        .from("streamers")
        .select("id, rarity_weights, card_pack_names")
        .eq("id", streamerId)
        .eq("twitch_user_id", session.twitchUserId)
        .maybeSingle();

      // Issue #393再設計: card_pack_names(事前登録パック一覧)列がデプロイ窓で
      // まだ無い場合、membership検証ができない。ownership確認自体は
      // rarity_weightsのみで継続できるようフォールバックする。
      if (streamerSelectError && isMissingCardPackNamesColumnError(streamerSelectError)) {
        const retryResult = await supabaseAdmin
          .from("streamers")
          .select("id, rarity_weights")
          .eq("id", streamerId)
          .eq("twitch_user_id", session.twitchUserId)
          .maybeSingle();
        streamerData = retryResult.data ? { ...retryResult.data, card_pack_names: [] as string[] } : null;
        streamerSelectError = retryResult.error;
        cardPackNamesUnavailable = true;
      }
      streamer = streamerData;
    }

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const registeredPackNames: string[] = Array.isArray(streamer.card_pack_names)
      ? streamer.card_pack_names
      : [];

    // Issue #393再設計: 新規カードには比較対象の現在値が無いため、非null値は
    // 常に「新規紐付け」として扱い、事前登録済みパック名であることを要求する
    // (Issue #269のプレミアムゲートは廃止。パック管理モーダルでの追加時のみ
    // ゲートする設計に変更したため、ここではmembership検証のみ行う)。
    if (
      collectionNameResult.value !== undefined &&
      collectionNameResult.value !== null &&
      !cardPackNamesUnavailable &&
      !isRegisteredOrUnchanged(collectionNameResult.value, null, registeredPackNames)
    ) {
      return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
    }

    // デプロイ窓(card_pack_names未検出)で非null値が指定された場合は、
    // membership検証ができないため書き込み自体を見送る(カード作成は続行)。
    const collectionNameSkippedDeployWindow =
      cardPackNamesUnavailable && collectionNameResult.value !== undefined && collectionNameResult.value !== null;

    // NOTE: Drop rate validation removed because the system uses relative weights
    // The actual probability is calculated as: this_card_weight / total_weights
    // So there's no need to limit the sum to 100% - weights are relative, not absolute percentages
    // 注意: ドロップレート検証を削除。システムは相対重みを使用するため
    // 実際の確率は「このカードの重み / 全体の重み」で計算される
    // 重みは相対的であり絶対的な割合ではないため、合計100%制限は不要

    const normalizedRarity = typeof rarity === "string" ? rarity.trim() : rarity;
    const insertData: Record<string, unknown> = {
      streamer_id: streamerId,
      name,
      description,
      image_url: imageUrl,
      rarity: normalizedRarity,
      card_number: cardNumber ?? null,
      max_issuance_count: parsedIssuanceLimit,
      drop_rate: dropRate,
    };
    // Issue #393: persist the pack name when provided (null clears it = all cards).
    // Issue #393再設計: デプロイ窓でmembership検証ができない場合は書き込み自体を見送る。
    if (collectionNameResult.value !== undefined && !collectionNameSkippedDeployWindow) {
      insertData.collection_name = collectionNameResult.value;
    }
    if (intraRarityWeight !== undefined) {
      insertData.intra_rarity_weight = intraRarityWeight;
    }

    // #663: pg 経路(usePgWrite)では insertCardPg に委譲する。postgrest 経路は
    // 既存実装のまま(内側の変数名のみ card → cardData に変更。if/else 分岐の
    // 外側で共有する card 変数とのシャドーイングを避けるための構造上の都合であり、
    // クエリ・カスケードリトライの条件分岐ロジックは無変更)。
    let card: Record<string, unknown> | null;
    let error: unknown;

    if (usePgWrite) {
      const result = await insertCardPg(insertData);
      card = result.data;
      error = result.error;
    } else {
      let { data: cardData, error: insertError } = await supabaseAdmin
        .from("cards")
        .insert(insertData)
        .select()
        .maybeSingle();

      if (insertError && isMissingCardNumberColumnError(insertError)) {
        delete insertData.card_number;
        const retryResult = await supabaseAdmin
          .from("cards")
          .insert(insertData)
          .select()
          .maybeSingle();
        cardData = retryResult.data;
        insertError = retryResult.error;
      }
      if (insertError && isMissingCardIssuanceColumnError(insertError)) {
        delete insertData.max_issuance_count;
        const retryResult = await supabaseAdmin
          .from("cards")
          .insert(insertData)
          .select()
          .maybeSingle();
        cardData = retryResult.data;
        insertError = retryResult.error;
      }

      // Issue #393: deploy-window safety. If collection_name is not migrated yet,
      // retry without it so card creation still succeeds (the pack is dropped for
      // this card; the streamer can re-assign it once the column is live). Mirrors
      // the card_number missing-column retry above.
      if (insertError && isMissingCollectionNameColumn(insertError) && "collection_name" in insertData) {
        delete insertData.collection_name;
        const retryResult = await supabaseAdmin
          .from("cards")
          .insert(insertData)
          .select()
          .maybeSingle();
        cardData = retryResult.data;
        insertError = retryResult.error;
      }
      card = cardData;
      error = insertError;
    }

    if (error) {
      if (isCardNumberConflictError(error)) {
        return NextResponse.json(
          { error: CARD_NUMBER_MESSAGES.duplicate },
          { status: 409 }
        );
      }
      return handleDatabaseError(error, "Cards API: Failed to create card");
    }

    // 再計算はベストエフォート: カード作成は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    try {
      recalculatedCards = await recalculateIfAutoMode(
        supabaseAdmin,
        streamerId,
        streamer.rarity_weights
      );
    } catch (recalculationError) {
      logger.error("Cards API: Recalculation failed after card creation", recalculationError);
    }

    // Note: Cache invalidation is handled by TTL (30 seconds)
    // Short TTL ensures new cards appear quickly without manual invalidation
    // 注意: キャッシュ無効化はTTL（30秒）で処理
    // 短いTTLにより手動で無効化せずとも新しいカードがすぐに表示される

    return NextResponse.json({
      ...card,
      recalculatedCards,
      ...(collectionNameSkippedDeployWindow ? { collectionNameSkippedDeployWindow: true } : {}),
    });
  } catch (error) {
    return handleApiError(error, "Cards API: POST");
  }
}

// Valid sort fields for cards
// カードの有効な並び替えフィールド
const VALID_SORT_FIELDS = ["created_at", "rarity", "drop_rate", "card_number", "display_order"] as const;
type SortField = typeof VALID_SORT_FIELDS[number];

// Valid sort directions
// 有効な並び替え方向
const VALID_SORT_DIRECTIONS = ["asc", "desc"] as const;
type SortDirection = typeof VALID_SORT_DIRECTIONS[number];

// Valid status filters
// 有効なステータスフィルター
const VALID_STATUS_FILTERS = ["all", "active", "inactive"] as const;
type StatusFilter = typeof VALID_STATUS_FILTERS[number];

// Issue #542: cards一覧に「発行済み枚数」を付与する際に参照する最小限の形状
// Minimal shape needed to attach issued counts to a cards-list row
type CardWithIssuanceLimit = { id: string; max_issuance_count?: number | null };

/**
 * Issue #542 (CardManagerで発行済み枚数・残余枚数を表示する):
 * max_issuance_count が設定された「限定カード」のみ、user_cards から発行済み
 * 枚数を取得して issued_count として付与する。
 *
 * - 限定カードが0件（大多数のケース = 無制限カードのみ）なら user_cards への
 *   問い合わせ自体をスキップし、不要なDB負荷を避ける（Issueの受け入れ条件）。
 * - Supabase(PostgREST)クライアントは任意のGROUP BY集計をサポートしないため、
 *   対象カードのuser_cards.card_idを1クエリで取得し、アプリ側でCOUNTする
 *   （Issue #548と同様の「limited-card subsetのみ対象にする」考え方）。
 *   行数は対象カードの発行上限に頭打ちされるため、無制限カードを含む全件
 *   カウントより大幅に軽い。
 * - 取得に失敗してもカード一覧自体は返す（ベストエフォート）。issued_countが
 *   付与されないだけで、UI側は無制限カードと同様に枚数表示をスキップする。
 *
 * Only cards with max_issuance_count set ("limited cards") get an issued_count
 * looked up from user_cards. Skips the query entirely when there are no limited
 * cards on the page (the common case) to avoid unnecessary DB load. PostgREST
 * has no arbitrary GROUP BY, so we fetch card_id rows for the limited subset in
 * a single query and COUNT them in application code (bounded by each card's
 * issuance cap, not the whole table). Failures are best-effort: the card list
 * is still returned, just without issued_count.
 */
async function attachIssuedCounts<T extends CardWithIssuanceLimit>(
  supabaseAdmin: ReturnType<typeof getSupabaseAdmin>,
  cards: T[]
): Promise<Array<T & { issued_count?: number }>> {
  const limitedCardIds = cards
    .filter((card) => card.max_issuance_count !== null && card.max_issuance_count !== undefined)
    .map((card) => card.id);

  if (limitedCardIds.length === 0) {
    return cards;
  }

  const { data: issuedRows, error } = await supabaseAdmin
    .from("user_cards")
    .select("card_id")
    .in("card_id", limitedCardIds);

  if (error) {
    logger.error("Cards API: Failed to fetch issued counts (Issue #542)", error);
    return cards;
  }

  const issuedCounts = new Map<string, number>();
  for (const row of (issuedRows || []) as { card_id: string }[]) {
    issuedCounts.set(row.card_id, (issuedCounts.get(row.card_id) || 0) + 1);
  }

  return cards.map((card) => {
    if (card.max_issuance_count === null || card.max_issuance_count === undefined) {
      return card;
    }
    return { ...card, issued_count: issuedCounts.get(card.id) ?? 0 };
  });
}

/**
 * attachIssuedCounts の pg 直結実装 (#663)。
 *
 * PostgREST 実装との対応:
 * - .in("card_id", limitedCardIds) は Drizzle の inArray で等価。取得後に
 *   JS 側で card_id ごとに件数を集計するロジックも既存実装と同一
 *   (GROUP BY を使わず Postgres 側の集計方式を揃える理由は既存コメント参照)。
 * - 取得失敗はログのみでカード一覧自体は返す(ベストエフォート。既存と同じ)。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function attachIssuedCountsPg<T extends CardWithIssuanceLimit>(
  cards: T[]
): Promise<Array<T & { issued_count?: number }>> {
  const limitedCardIds = cards
    .filter((card) => card.max_issuance_count !== null && card.max_issuance_count !== undefined)
    .map((card) => card.id);

  if (limitedCardIds.length === 0) {
    return cards;
  }

  let issuedRows: Array<{ card_id: string }>;
  try {
    issuedRows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ card_id: userCardsTable.card_id })
          .from(userCardsTable)
          .where(inArray(userCardsTable.card_id, limitedCardIds));
      },
      "Cards API: attachIssuedCounts(pg)",
      { idempotent: true }
    );
  } catch (error) {
    logger.error("Cards API: Failed to fetch issued counts (Issue #542, pg)", error);
    return cards;
  }

  const issuedCounts = new Map<string, number>();
  for (const row of issuedRows) {
    issuedCounts.set(row.card_id, (issuedCounts.get(row.card_id) || 0) + 1);
  }

  return cards.map((card) => {
    if (card.max_issuance_count === null || card.max_issuance_count === undefined) {
      return card;
    }
    return { ...card, issued_count: issuedCounts.get(card.id) ?? 0 };
  });
}

/**
 * fetchCardsFromDB の pg 直結実装 (#663)。unstable_cache の「中」
 * (fetchCardsFromDB 冒頭)で分岐するため、キャッシュキー・タグ・TTL の構造は
 * 両経路で完全に同一(dashboard-data.ts の fetchActiveCardsForStreamerFromDB と
 * 同じ設計)。
 *
 * PostgREST 実装との対応:
 * - count は既存実装が 1 クエリ({ count: "exact" })で行と同時取得するが、
 *   Drizzle には同等の単一往復手段が無いため、まず count(*) だけを取得し
 *   (並び替え列に依存しないため card_number 未デプロイの影響を受けない)、
 *   その後に行本体を取得する 2 クエリ構成にする(同一 Hyperdrive 接続内の
 *   追加ラウンドトリップであり、Cloudflare のサブリクエスト制限には数えない)。
 * - nullsFirst:false(常に NULLS LAST)は asc()/desc() ヘルパーに nulls 指定が
 *   無いため、raw sql フラグメントで明示する。
 * - card_number / display_order ソートで列未デプロイ(42703)の場合、既存実装と
 *   同じく created_at 昇順(呼び出し時の ascending 値)へフォールバックする。
 *   count は並び替え列に依存しないため再取得しない(既存実装は同一 where 条件で
 *   再取得するだけで値は変わらないため、外部挙動としては同じ)。
 */
async function fetchCardsFromDBPg(
  streamerId: string,
  limit: number,
  offset: number,
  sortField: SortField,
  sortDirection: SortDirection,
  statusFilter: StatusFilter,
  includeInactive: boolean
): Promise<{ cards: unknown[]; count: number | null }> {
  const start = Date.now();

  const buildConditions = () => {
    const conditions = [eq(cardsTable.streamer_id, streamerId)];
    if (statusFilter === "active") {
      conditions.push(eq(cardsTable.is_active, true));
    } else if (statusFilter === "inactive") {
      conditions.push(eq(cardsTable.is_active, false));
    } else if (!includeInactive && statusFilter === "all") {
      // Legacy behavior handled in caller (postgrest 経路と同じく no-op)
    }
    return conditions;
  };

  const total = await withDbRetry(
    async () => {
      const { db } = await getDb();
      const rows = await db
        .select({ value: sqlCount() })
        .from(cardsTable)
        .where(and(...buildConditions()));
      return rows[0]?.value ?? 0;
    },
    "fetchCardsFromDB(count,pg)",
    { idempotent: true }
  );

  const ascending = sortDirection === "asc";
  const dbSortField = sortField === "rarity"
    ? "rarity_order"
    : sortField === "display_order"
      ? "card_number"
      : sortField;

  const sortColumn =
    dbSortField === "rarity_order" ? cardsTable.rarity_order
      : dbSortField === "card_number" ? cardsTable.card_number
        : dbSortField === "drop_rate" ? cardsTable.drop_rate
          : cardsTable.created_at;

  // PostgREST の nullsFirst:false(常に NULLS LAST)を再現する raw sql フラグメント
  const orderByNullsLast = (column: typeof sortColumn, asc: boolean) =>
    asc ? sql`${column} ASC NULLS LAST` : sql`${column} DESC NULLS LAST`;

  let cardRows: Record<string, unknown>[];
  try {
    cardRows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        const base = db.select().from(cardsTable).where(and(...buildConditions()));
        const ordered = sortField === "display_order"
          ? base.orderBy(orderByNullsLast(cardsTable.card_number, ascending), orderByNullsLast(cardsTable.created_at, true))
          : base.orderBy(orderByNullsLast(sortColumn, ascending));
        return ordered.limit(limit).offset(offset);
      },
      "fetchCardsFromDB(rows,pg)",
      { idempotent: true }
    );
  } catch (fetchError) {
    if (
      (sortField === "card_number" || sortField === "display_order") &&
      isPgMissingColumnError(fetchError)
    ) {
      cardRows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select()
            .from(cardsTable)
            .where(and(...buildConditions()))
            .orderBy(orderByNullsLast(cardsTable.created_at, ascending))
            .limit(limit)
            .offset(offset);
        },
        "fetchCardsFromDB(rows fallback,pg)",
        { idempotent: true }
      );
    } else {
      throw fetchError;
    }
  }

  // Issue #542: 限定カードにのみ発行済み枚数(issued_count)を付与する
  const cardsWithIssuedCounts = await attachIssuedCountsPg(
    normalizeDropRate(cardRows as Array<{ drop_rate: unknown } & CardWithIssuanceLimit>)
  );

  logger.info(`[Perf] fetchCardsFromDB(pg): ${Date.now() - start}ms (${cardRows.length} cards)`);

  return { cards: cardsWithIssuedCounts, count: total };
}

/**
 * Internal function to fetch cards from database (used for caching)
 * データベースからカードを取得する内部関数（キャッシュ用）
 */
async function fetchCardsFromDB(
  streamerId: string,
  limit: number,
  offset: number,
  sortField: SortField,
  sortDirection: SortDirection,
  statusFilter: StatusFilter,
  includeInactive: boolean
): Promise<{ cards: unknown[]; count: number | null }> {
  // #663: 読み取り専用の内部関数のため isPgReadEnabled() で分岐する。
  // unstable_cache の「中」で分岐するためキャッシュ構造は両経路で同一
  // (dashboard-data.ts の fetchActiveCardsForStreamerFromDB と同じ設計)。
  if (isPgReadEnabled()) {
    return fetchCardsFromDBPg(streamerId, limit, offset, sortField, sortDirection, statusFilter, includeInactive);
  }

  const start = Date.now();
  const supabaseAdmin = getSupabaseAdmin();

  let query = supabaseAdmin
    .from("cards")
    .select("*", { count: "exact" })
    .eq("streamer_id", streamerId);

  // Apply status filter
  // ステータスフィルターを適用
  if (statusFilter === "active") {
    query = query.eq("is_active", true);
  } else if (statusFilter === "inactive") {
    query = query.eq("is_active", false);
  } else if (!includeInactive && statusFilter === "all") {
    // Legacy behavior handled in caller
  }

  // Apply sorting - all fields use DB-side sorting for correct pagination
  // 並び替えを適用 - ページネーション整合性のため全フィールドDB側でソート
  const ascending = sortDirection === "asc";
  // Use stable DB-side ordering for correct pagination.
  // display_order uses manually assigned card numbers first, then old cards first.
  const dbSortField = sortField === "rarity"
    ? "rarity_order"
    : sortField === "display_order"
      ? "card_number"
      : sortField;
  query = query.order(dbSortField, { ascending, nullsFirst: false });
  if (sortField === "display_order") {
    query = query.order("created_at", { ascending: true, nullsFirst: false });
  }
  query = query.range(offset, offset + limit - 1);

  let { data: cards, error, count } = await query;
  if (
    error &&
    (sortField === "card_number" || sortField === "display_order") &&
    isMissingCardNumberColumnError(error)
  ) {
    const fallbackQuery = supabaseAdmin
      .from("cards")
      .select("*", { count: "exact" })
      .eq("streamer_id", streamerId);

    let filteredFallbackQuery = fallbackQuery;
    if (statusFilter === "active") {
      filteredFallbackQuery = filteredFallbackQuery.eq("is_active", true);
    } else if (statusFilter === "inactive") {
      filteredFallbackQuery = filteredFallbackQuery.eq("is_active", false);
    }

    const fallbackResult = await filteredFallbackQuery
      .order("created_at", { ascending, nullsFirst: false })
      .range(offset, offset + limit - 1);
    cards = fallbackResult.data;
    error = fallbackResult.error;
    count = fallbackResult.count;
  }
  if (error) throw error;

  // Issue #542: 限定カードにのみ発行済み枚数(issued_count)を付与する
  const cardsWithIssuedCounts = await attachIssuedCounts(
    supabaseAdmin,
    normalizeDropRate((cards || []) as Array<{ drop_rate: unknown } & CardWithIssuanceLimit>)
  );

  logger.info(`[Perf] fetchCardsFromDB: ${Date.now() - start}ms (${cards?.length || 0} cards)`);

  return { cards: cardsWithIssuedCounts, count };
}

/**
 * GET /api/cards の streamer 所有権確認の pg 直結実装 (#663)。
 *
 * .eq("id", ...).eq("twitch_user_id", ...).maybeSingle() は streamers.id が PK の
 * ため LIMIT 1 + rows[0] ?? null で同じ外部挙動。session が無い場合
 * (twitchUserId が undefined)は既存実装の `.eq("twitch_user_id", undefined)` と
 * 同様に「一致する行が無い」という結果に倒す(twitch_user_id は NOT NULL のため
 * 空文字と一致する streamer は実運用上存在しない)。
 * 取得失敗時も既存実装(`if (streamerError || !streamer) return 403`、エラー種別を
 * 区別せず 403 に倒す)と同じ外部挙動にするため、例外を握りつぶして null を返す。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchCardsListStreamerOwnershipPg(
  streamerId: string,
  twitchUserId: string | undefined
): Promise<{ id: string } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(and(eq(streamersTable.id, streamerId), eq(streamersTable.twitch_user_id, twitchUserId ?? "")))
          .limit(1);
      },
      "GET /api/cards(streamer ownership,pg)",
      { idempotent: true }
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  const { searchParams } = new URL(request.url);
  const streamerId = searchParams.get("streamerId");
  // Pagination parameters
  // ページネーションパラメータ
  // CardManager requests limit=1000 to load all cards for management view
  // カード管理画面では全カード取得のためlimit=1000でリクエストされる
  const limit = Math.min(parseInt(searchParams.get("limit") || "12", 10), 1000);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  // Sorting parameters (default: created_at desc)
  // 並び替えパラメータ（デフォルト: created_at 降順）
  const sortFieldParam = searchParams.get("sortField") || "created_at";
  const sortField: SortField = VALID_SORT_FIELDS.includes(sortFieldParam as SortField)
    ? sortFieldParam as SortField
    : "created_at";
  const sortDirParam = searchParams.get("sortDirection") || "desc";
  const sortDirection: SortDirection = VALID_SORT_DIRECTIONS.includes(sortDirParam as SortDirection)
    ? sortDirParam as SortDirection
    : "desc";

  // Status filter parameter (default: all for includeInactive=true, active otherwise)
  // ステータスフィルターパラメータ（デフォルト: includeInactive=trueならall、それ以外はactive）
  const statusParam = searchParams.get("status");
  const statusFilter: StatusFilter = statusParam && VALID_STATUS_FILTERS.includes(statusParam as StatusFilter)
    ? statusParam as StatusFilter
    : "all";

  // Legacy support: includeInactive parameter
  // レガシーサポート: includeInactiveパラメータ
  const includeInactive = searchParams.get("includeInactive") === "true";

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier);

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

  if (!streamerId) {
    return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_ID_MISSING }, { status: 400 });
  }

  try {
    // #663: 読み取り専用のため isPgReadEnabled() で分岐する(pg-read でも切替)。
    const supabaseAdmin = getSupabaseAdmin();
    const { data: streamer, error: streamerError } = isPgReadEnabled()
      ? { data: await fetchCardsListStreamerOwnershipPg(streamerId, session?.twitchUserId), error: null }
      : await supabaseAdmin
          .from("streamers")
          .select("id")
          .eq("id", streamerId)
          .eq("twitch_user_id", session?.twitchUserId)
          .maybeSingle();

    if (streamerError || !streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Use cached fetch to reduce CPU usage from repeated queries
    // 繰り返しクエリによるCPU使用量を削減するためキャッシュ済みフェッチを使用
    const cacheKey = `cards-${streamerId}-${limit}-${offset}-${sortField}-${sortDirection}-${statusFilter}-${includeInactive}`;
    const cachedFetch = unstable_cache(
      async () => fetchCardsFromDB(streamerId, limit, offset, sortField, sortDirection, statusFilter, includeInactive),
      [cacheKey],
      {
        revalidate: CARDS_CACHE_TTL,
        tags: [`cards-${streamerId}`],
      }
    );

    const { cards, count } = await cachedFetch();

    // Return paginated response with metadata
    // メタデータ付きのページネーションレスポンスを返す
    return NextResponse.json({
      cards,
      pagination: {
        total: count || 0,
        limit,
        offset,
        hasMore: (count || 0) > offset + limit,
      },
    });
  } catch (error) {
    return handleApiError(error, "Cards API: GET");
  }
}
