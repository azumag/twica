import { type NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getSession, canUseStreamerFeatures } from "@/lib/session";

import {
  validateCardName,
  validateCardDescription,
  validateImageUrl,
  validateRarity,
  validateImagePaddingColor,
} from "@/lib/validations";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier, retryAfterSeconds } from "@/lib/rate-limit";
import { safeParseInt } from "@/lib/parse";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { normalizeDropRate } from "@/lib/card-utils";
import { getStorageUsage } from "@/lib/storage-usage";
import { sha256Prefix } from "@/lib/crypto-utils";
import { isAssignableImageUrl } from "@/lib/storage-utils";
import { logger } from "@/lib/logger.server";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
import { CARD_NUMBER_MESSAGES, isCardNumberConflictError, isMissingCardNumberColumnError } from "@/lib/card-number-errors";
import { CARD_ISSUANCE_MESSAGES, isMissingCardIssuanceColumnError, parseCardIssuanceLimit } from "@/lib/card-issuance";
import { resolveCollectionNameField, isRegisteredOrUnchanged } from "@/lib/validation/collection-name";
import { isMissingCollectionNameColumn, isMissingCardPackNamesColumnError } from "@/lib/collections/collection-existence";
// -----------------------------------------------------------------------------
// カードの読み取りと更新は PlanetScale の単一接続を使う。
// 接続は各 xxxPg 関数の withDbRetry queryFn 内で取得する。
// -----------------------------------------------------------------------------
import { and, count as countAggregate, eq, inArray, sql, type AnyColumn } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable, streamers as streamersTable, userCards as userCardsTable } from "@/lib/db/schema";
import { CARDS_COLUMNS_WITHOUT_PADDING_COLOR, isMissingCardPaddingColorError } from "@/lib/db/card-padding-color-errors";
import type { ApiRateLimitResponse } from "@/types/api";

// pg (postgres.js) が throw するエラーの汎用形状。card-number-errors.ts /
// 両対応の汎用判定（error.code の SQLSTATE、error.message のテキスト一致）のため、
// この形にキャストするだけで pg のエラーも判定できる（新規ヘルパーは作らない）。
type CardsSchemaError = { message?: string; code?: string; details?: string; hint?: string } | null | undefined;

// Cache TTL for cards list (30 seconds to balance freshness and CPU usage)
// カード一覧のキャッシュTTL（新鮮さとCPU使用量のバランスで30秒）
const CARDS_CACHE_TTL = 30;

/**
 * POST /api/cards の streamer 所有権確認 (id, rarity_weights, card_pack_names) の
 * pg 直結実装 (#663)。card_pack_names 列未デプロイ時のフォールバックを含む。
 *
 * - `.eq("id", ...).eq("twitch_user_id", ...).maybeSingle()` は id が PK のため
 *   LIMIT 1 + rows[0] ?? null で同じ外部挙動。
 * - card_pack_names 列未デプロイ(42703)を検知したら列を落として再試行し、
 * - 想定外のエラーは throw して呼び出し元(POST)の外側 catch で 500 にする。
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
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
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
      "Cards API POST: streamer ownership check",
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true }
    );
    return { streamer: rows[0] ?? null, cardPackNamesUnavailable: false };
  } catch (error) {
    if (isMissingCardPackNamesColumnError(error as CardsSchemaError)) {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db
            .select({ id: streamersTable.id, rarity_weights: streamersTable.rarity_weights })
            .from(streamersTable)
            .where(and(eq(streamersTable.id, streamerId), eq(streamersTable.twitch_user_id, twitchUserId)))
            .limit(1);
        },
        "Cards API POST: streamer ownership check (retry without card_pack_names)",
        { idempotent: true }
      );
      const row = rows[0];
      return {
        streamer: row ? { ...row, card_pack_names: [] } : null,
        cardPackNamesUnavailable: true,
      };
    }
    throw error;
  }
}

/**
 * POST /api/cards のカード INSERT（card_number → max_issuance_count →
 * collection_name の3段階デプロイ窓フォールバック付き、さらに RETURNING 列の
 * image_padding_color フォールバックを末尾に追加）の pg 直結実装 (#663 self-review fix)。
 *
 * - `.insert(...).select().maybeSingle()` は `.insert(...).values(...).returning()`
 *   が等価（RETURNING で挿入行を1回の往復で取得）。
 * - 各フォールバックは同じ判定ヘルパー(isMissingCardNumberColumnError 等)を
 *   そのまま再利用する。ON CONFLICT の無い INSERT のため各試行は非冪等
 *   （withDbRetry にオプションを渡さない = リトライなし）。
 * - unique_violation (23505) は呼び出し元(POST)で isCardNumberConflictError
 *
 * #834: 「本番未デプロイ8列」（card_number/hp/atk/def/spd/skill_*）に対する
 * RETURNING フォールバックは、本番実測で8列とも実在することを確認したため撤去
 * した。image_padding_color（#899、本Issueとは独立した別デプロイ窓）だけは
 * 無指定 `.returning()` が失敗しうるため、CARDS_COLUMNS_WITHOUT_PADDING_COLOR
 * へ切り替えて最後にもう一度だけ再試行する（insertData に無い場合も RETURNING
 * は values() の内容と無関係に schema.ts の全列を要求するため、この最終
 * フォールバックが必要）。
 */
async function insertCardPg(
  insertDataInitial: Record<string, unknown>
): Promise<{ card: Record<string, unknown> | null; error: unknown }> {
  const insertData = { ...insertDataInitial };

  async function attemptInsert(
    useColumnsWithoutPaddingColor = false
  ): Promise<{ card: Record<string, unknown> | null; error: unknown }> {
    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          const query = db.insert(cardsTable).values(insertData as typeof cardsTable.$inferInsert);
          return useColumnsWithoutPaddingColor
            ? query.returning(CARDS_COLUMNS_WITHOUT_PADDING_COLOR)
            : query.returning();
        },
        "Cards API POST: insert card"
        // ON CONFLICT の無い INSERT は再実行で二重作成になりうるため非冪等（既定 = リトライなし）
      );
      return { card: rows[0] ?? null, error: null };
    } catch (error) {
      return { card: null, error };
    }
  }

  let { card, error } = await attemptInsert();

  // card_number は #393/#548 由来の独立したデプロイ窓フォールバック
  // （card-number-errors.ts、本Issue #834 のスコープ外）で、insertData から
  // 列を削るだけで RETURNING 自体は無指定のまま card_number を
  // 要求し続ける。#834 撤去前は末尾の CARDS_SAFE_COLUMNS（card_number も除外）が
  // これを最終的に救済していたが、card_number は本番・preview 実測済み（#834）
  // のため通常はこの分岐へ到達しない。真に card_number が欠落する環境では
  // このフォールバックは単独では完結しない点に注意（card-number-errors.ts 側の
  // 対応が必要。本Issueでは意図的に手を加えない。要否の実測・整理は #954 参照）。
  if (error && isMissingCardNumberColumnError(error)) {
    delete insertData.card_number;
    ({ card, error } = await attemptInsert());
  }
  if (error && isMissingCardIssuanceColumnError(error)) {
    delete insertData.max_issuance_count;
    ({ card, error } = await attemptInsert());
  }
  if (error && isMissingCollectionNameColumn(error as CardsSchemaError) && "collection_name" in insertData) {
    delete insertData.collection_name;
    ({ card, error } = await attemptInsert());
  }
  // #899: image_padding_color 列が migration 未適用の環境では、この列を落として再試行する
  //（余白情報だけが保存されず、カード作成自体は継続する）
  if (error && isMissingCardPaddingColorError(error) && "image_padding_color" in insertData) {
    delete insertData.image_padding_color;
    ({ card, error } = await attemptInsert());
  }
  // 上記までの入力値フォールバックを尽くしてもなお、無指定 RETURNING が
  // image_padding_color 列の欠落で失敗している場合、明示列リストで最後にもう
  // 一度だけ試す。image_padding_color が insertData に無い場合（未指定
  // リクエスト）は直前のフォールバックの `"image_padding_color" in insertData`
  // 条件を満たさずスキップされるため、この分岐が無いと migration 未適用の
  // 環境では imagePaddingColor を送らないカード作成まで含めて全滅していた
  // （#899 Fable厳格レビュー指摘・PR #903）。
  if (error && isMissingCardPaddingColorError(error)) {
    ({ card, error } = await attemptInsert(true));
  }

  return { card, error };
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
        retryAfter: retryAfterSeconds(rateLimitResult.reset)
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


    const body = await request.json();
    const { streamerId, name, description, imageUrl, rarity, dropRate, intraRarityWeight, cardNumber, maxIssuanceCount, imagePaddingColor } = body;

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

    // #830: 他人のストレージURLをカードへ紐付けることを禁止する。
    // 紐付けを許すと、以降の画像差し替え・カード削除のクリーンアップで
    // 他人のオブジェクトが削除される。
    if (!(await isAssignableImageUrl(imageUrl, session.twitchUserId))) {
      logger.warn(
        `Cards API: rejected foreign storage image URL on create by user ${session.twitchUserId}: ${imageUrl}`
      );
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const rarityValidation = validateRarity(rarity)
    if (!rarityValidation.valid) {
      return NextResponse.json(
        { error: rarityValidation.error },
        { status: 400 }
      )
    }

    // #899: 余白（fit）モードの色はホワイトリスト検証（表示側の CSS 背景色に使うため）
    const paddingColorValidation = validateImagePaddingColor(imagePaddingColor)
    if (!paddingColorValidation.valid) {
      return NextResponse.json(
        { error: paddingColorValidation.error },
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
    const streamerLookup = await fetchStreamerForCardCreatePg(streamerId, session.twitchUserId);
    const streamer = streamerLookup.streamer;
    const cardPackNamesUnavailable = streamerLookup.cardPackNamesUnavailable;

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
    // Issue #899: 余白（fit）モードの余白色。null は「余白なし」（従来のトリミング画像）。
    // undefined（未指定）と null を区別せず、省略時はそのまま省略する。
    if (imagePaddingColor !== undefined) {
      insertData.image_padding_color = imagePaddingColor === "" ? null : imagePaddingColor;
    }
    // Issue #393: persist the pack name when provided (null clears it = all cards).
    // Issue #393再設計: デプロイ窓でmembership検証ができない場合は書き込み自体を見送る。
    if (collectionNameResult.value !== undefined && !collectionNameSkippedDeployWindow) {
      insertData.collection_name = collectionNameResult.value;
    }
    if (intraRarityWeight !== undefined) {
      insertData.intra_rarity_weight = intraRarityWeight;
    }

    const { card, error } = await insertCardPg(insertData);

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
 * attachIssuedCounts の pg 直結実装 (#663)。limitedCardIds は呼び出し元
 * (attachIssuedCounts) 側で「1件も無ければ問い合わせをスキップする」判定済みの
 * ため、ここでは常に inArray で絞り込む。
 *
 * - `.in("card_id", limitedCardIds)` は inArray() が等価。
 * - 取得失敗はログのみでカード一覧自体は返す（ベストエフォート、既存と同じ）。
 */
async function attachIssuedCountsPg<T extends CardWithIssuanceLimit>(
  cards: T[],
  limitedCardIds: string[]
): Promise<Array<T & { issued_count?: number }>> {
  try {
    const issuedRows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ card_id: userCardsTable.card_id })
          .from(userCardsTable)
          .where(inArray(userCardsTable.card_id, limitedCardIds));
      },
      "Cards API: fetch issued counts (Issue #542, pg)",
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true }
    );

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
  } catch (error) {
    logger.error("Cards API: Failed to fetch issued counts (Issue #542)", error);
    return cards;
  }
}

/**
 * Issue #542 (CardManagerで発行済み枚数・残余枚数を表示する):
 * max_issuance_count が設定された「限定カード」のみ、user_cards から発行済み
 * 枚数を取得して issued_count として付与する。
 *
 * - 限定カードが0件（大多数のケース = 無制限カードのみ）なら user_cards への
 *   問い合わせ自体をスキップし、不要なDB負荷を避ける（Issueの受け入れ条件）。
 *   対象カードのuser_cards.card_idを1クエリで取得し、アプリ側でCOUNTする
 *   （Issue #548と同様の「limited-card subsetのみ対象にする」考え方）。
 *   行数は対象カードの発行上限に頭打ちされるため、無制限カードを含む全件
 *   カウントより大幅に軽い。
 * - 取得に失敗してもカード一覧自体は返す（ベストエフォート）。issued_countが
 *   付与されないだけで、UI側は無制限カードと同様に枚数表示をスキップする。
 *
 * Only cards with max_issuance_count set ("limited cards") get an issued_count
 * looked up from user_cards. Skips the query entirely when there are no limited
 * has no arbitrary GROUP BY, so we fetch card_id rows for the limited subset in
 * a single query and COUNT them in application code (bounded by each card's
 * issuance cap, not the whole table). Failures are best-effort: the card list
 * is still returned, just without issued_count.
 */
async function attachIssuedCounts<T extends CardWithIssuanceLimit>(
  cards: T[]
): Promise<Array<T & { issued_count?: number }>> {
  const limitedCardIds = cards
    .filter((card) => card.max_issuance_count !== null && card.max_issuance_count !== undefined)
    .map((card) => card.id);

  if (limitedCardIds.length === 0) {
    return cards;
  }

  // #663: 読み取り専用のため PlanetScale の単一接続を使用。
  return attachIssuedCountsPg(cards, limitedCardIds);
}

/**
 * `.order(col, { ascending, nullsFirst: false })` は昇順・降順どちらでも
 * NULL を末尾に置くが、PostgreSQL の素の ASC/DESC のデフォルトは
 * 「ASC=NULLS LAST」「DESC=NULLS FIRST」なので、DESC側は明示指定しないと
 * 挙動が変わってしまう。drizzle-orm の asc()/desc() は本バージョンでは
 * nulls 制御のチェーンを持たないため、sql テンプレートで直接組み立てる。
 */
function orderByNullsLast(column: AnyColumn, ascending: boolean) {
  return ascending ? sql`${column} ASC NULLS LAST` : sql`${column} DESC NULLS LAST`;
}

function resolveSortColumn(sortField: SortField): AnyColumn {
  switch (sortField) {
    case "rarity":
      return cardsTable.rarity_order;
    case "display_order":
      return cardsTable.card_number;
    case "drop_rate":
      return cardsTable.drop_rate;
    case "card_number":
      return cardsTable.card_number;
    case "created_at":
    default:
      return cardsTable.created_at;
  }
}

/**
 * fetchCardsFromDB の pg 直結実装 (#663)。
 *
 * 件数取得を1往復にまとめるが、Drizzle に同等機能は無いため、(1) COUNT(*) の
 * クエリと (2) ページネーション済みの行取得クエリの2クエリに分ける。往復数の
 * 完全一致ではなく、最終的な count の値と rows の内容が一致することを機能的
 * パリティの基準とする（Issue #663 の指示どおり）。
 *
 * card_number/display_order ソート時の列未デプロイフォールバックは、COUNT側
 * クエリはソート列を使わないため対象外（元々失敗しない）。行取得クエリのみ
 * created_at 降順へのフォールバックを行う。
 *
 * #834: 「本番未デプロイ8列」（card_number/hp/atk/...）に対する SELECT 列
 * リストのフォールバックは、本番実測で8列とも実在することを確認したため撤去
 * した（card-padding-color-errors.ts 参照）。
 */
async function fetchCardsFromDBPg(
  streamerId: string,
  limit: number,
  offset: number,
  sortField: SortField,
  sortDirection: SortDirection,
  statusFilter: StatusFilter
): Promise<{ cards: unknown[]; count: number | null }> {
  const conditions = [eq(cardsTable.streamer_id, streamerId)];
  if (statusFilter === "active") {
    conditions.push(eq(cardsTable.is_active, true));
  } else if (statusFilter === "inactive") {
    conditions.push(eq(cardsTable.is_active, false));
  }
  const whereCondition = and(...conditions);

  const countRows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db.select({ count: countAggregate() }).from(cardsTable).where(whereCondition);
    },
    "fetchCardsFromDB(pg): count",
    { idempotent: true }
  );
  const total = countRows[0]?.count ?? 0;

  const ascending = sortDirection === "asc";
  const primarySortColumn = resolveSortColumn(sortField);
  const primaryOrderExprs = [orderByNullsLast(primarySortColumn, ascending)];
  if (sortField === "display_order") {
    primaryOrderExprs.push(orderByNullsLast(cardsTable.created_at, true));
  }

  async function selectRows(orderExprs: ReturnType<typeof orderByNullsLast>[]) {
    return withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select()
          .from(cardsTable)
          .where(whereCondition)
          .orderBy(...orderExprs)
          .limit(limit)
          .offset(offset);
      },
      "fetchCardsFromDB(pg): rows",
      { idempotent: true }
    );
  }

  let orderExprs = primaryOrderExprs;
  let rows: unknown[];
  let rowsError: unknown = null;

  try {
    rows = await selectRows(orderExprs);
  } catch (error) {
    rows = [];
    rowsError = error;
  }

  // card_number ソート列のこのフォールバックも insertCardPg 側と同じ理由で、
  // card_number が真に欠落する環境では単独では完結しない（#834 のスコープ外。
  // card-number-errors.ts 側の対応が必要。要否の実測・整理は #954 参照）。
  // card_number は本番・preview 実測済み（#834）のため通常はここへ到達しない。
  if (
    rowsError &&
    (sortField === "card_number" || sortField === "display_order") &&
    isMissingCardNumberColumnError(rowsError)
  ) {
    orderExprs = [orderByNullsLast(cardsTable.created_at, ascending)];
    try {
      rows = await selectRows(orderExprs);
      rowsError = null;
    } catch (error) {
      rowsError = error;
    }
  }

  if (rowsError) {
    throw rowsError;
  }

  return { cards: rows, count: total };
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
  statusFilter: StatusFilter
): Promise<{ cards: unknown[]; count: number | null }> {
  const start = Date.now();


  // #663: 読み取り専用のため PlanetScale の単一接続を使用。
  const { cards: pgCards, count: pgCount } = await fetchCardsFromDBPg(
    streamerId,
    limit,
    offset,
    sortField,
    sortDirection,
    statusFilter
  );
  const cardsWithIssuedCounts = await attachIssuedCounts(
    normalizeDropRate(pgCards as Array<{ drop_rate: unknown } & CardWithIssuanceLimit>)
  );
  logger.info(`[Perf] fetchCardsFromDB: ${Date.now() - start}ms (${pgCards.length} cards)`);
  return { cards: cardsWithIssuedCounts, count: pgCount };
}

/**
 * GET /api/cards の streamer 所有権確認 (id のみ) の pg 直結実装 (#663)。
 * 読み取り専用のため PlanetScale の単一接続を使用する。twitchUserId が undefined
 * （未ログイン）の場合は空文字列で照合し、常に不一致（403）にする —
 * 一致しないのと同じ「認証なしは常に forbidden」という外部挙動を保つ。
 */
async function checkStreamerOwnershipForCardsListPg(
  streamerId: string,
  twitchUserId: string | undefined
): Promise<boolean> {
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
      "Cards API GET: streamer ownership check",
      { idempotent: true }
    );
    return rows.length > 0;
  } catch {
    // 分岐（403）に倒れる。pg 版も同じ外部挙動に合わせる。
    return false;
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
  // Issue #836: parseInt 直接使用（"abc"→NaN、負値そのまま）をやめ、
  // safeParseInt + clamp で PostgreSQL へ不正値を渡さない。
  const limit = Math.min(safeParseInt(searchParams.get("limit"), 12), 1000);
  const offset = Math.max(0, safeParseInt(searchParams.get("offset"), 0));

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

  // Status filter parameter (default: all)
  // ステータスフィルターパラメータ（デフォルト: all）
  const statusParam = searchParams.get("status");
  const statusFilter: StatusFilter = statusParam && VALID_STATUS_FILTERS.includes(statusParam as StatusFilter)
    ? statusParam as StatusFilter
    : "all";

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsGet, identifier);

  if (!rateLimitResult.success) {
    return NextResponse.json<ApiRateLimitResponse>(
      {
        error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
        retryAfter: retryAfterSeconds(rateLimitResult.reset)
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

    const streamerFound = await checkStreamerOwnershipForCardsListPg(
      streamerId,
      session?.twitchUserId,
    );

    if (!streamerFound) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Use cached fetch to reduce CPU usage from repeated queries
    // 繰り返しクエリによるCPU使用量を削減するためキャッシュ済みフェッチを使用
    const cacheKey = `cards-${streamerId}-${limit}-${offset}-${sortField}-${sortDirection}-${statusFilter}`;
    const cachedFetch = unstable_cache(
      async () => fetchCardsFromDB(streamerId, limit, offset, sortField, sortDirection, statusFilter),
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
