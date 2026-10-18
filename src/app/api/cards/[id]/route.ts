import { getTranslations } from 'next-intl/server';
import { getRewardCardProtectionPack } from '@/lib/pack-completion-reward-errors';
import { type NextRequest, NextResponse } from "next/server";
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
import { extractTwitchUserId } from "@/types/database";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { logger } from "@/lib/logger.server";
import { deleteOwnedStorageImage } from "@/lib/storage-cleanup";
import { isAssignableImageUrl } from "@/lib/storage-utils";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
import { CARD_NUMBER_MESSAGES, isCardNumberConflictError } from "@/lib/card-number-errors";
import { CARD_ISSUANCE_MESSAGES, isMissingCardIssuanceColumnError, parseCardIssuanceLimit } from "@/lib/card-issuance";
import { resolveCollectionNameField, isRegisteredOrUnchanged } from "@/lib/validation/collection-name";
import { isMissingCollectionNameColumn, isMissingCardPackNamesColumnError } from "@/lib/collections/collection-existence";
// -----------------------------------------------------------------------------
// #663 (#570/#572 パイロット踏襲): PlanetScale 接続。PUT/DELETE とも読み取り
// （所有権確認）と書き込み（UPDATE/DELETE）が混在するため、関数全体を
// PlanetScale の単一接続を使用する（token-manager.ts の getBotAccountForChat と
// 置き、getDb() は withDbRetry の queryFn 内で呼ぶ規約(src/lib/db/retry.ts 参照)。
// -----------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable, streamers as streamersTable } from "@/lib/db/schema";
import { CARDS_COLUMNS_WITHOUT_PADDING_COLOR, isMissingCardPaddingColorError } from "@/lib/db/card-padding-color-errors";
import { revalidateTag } from "next/cache";
import { cardsListCacheTag, updateCardTradeWantable } from "@/lib/card-trade-wantable";
import type { ApiRateLimitResponse } from "@/types/api";

// pg (postgres.js) が throw するエラーの汎用形状。card-number-errors.ts /
// 両対応の汎用判定（error.code の SQLSTATE、error.message のテキスト一致）のため、
// この形にキャストするだけで pg のエラーも判定できる（新規ヘルパーは作らない）。
type CardsSchemaError = { message?: string; code?: string; details?: string; hint?: string } | null | undefined;

function extractRarityWeights(streamers: unknown): Record<string, number> | null {
  if (!streamers) return null;
  if (Array.isArray(streamers)) {
    const first = streamers[0];
    if (first && typeof first === "object" && "rarity_weights" in first) {
      return (first as { rarity_weights: Record<string, number> | null }).rarity_weights;
    }
    return null;
  }
  if (typeof streamers === "object" && "rarity_weights" in streamers) {
    return (streamers as { rarity_weights: Record<string, number> | null }).rarity_weights;
  }
  return null;
}

// Issue #393再設計: streamers埋め込みからcard_pack_names(事前登録パック一覧)を読む。
// extractRarityWeightsと同じ「array/objectどちらの埋め込み形状にも対応する」パターン。
function extractCardPackNames(streamers: unknown): string[] {
  const readFrom = (value: unknown): string[] => {
                     if (value && typeof value === "object" && "card_pack_names" in value) {
      const raw = (value as { card_pack_names: unknown }).card_pack_names;
      return Array.isArray(raw) ? (raw as string[]) : [];
    }
    return [];
  };
  if (!streamers) return [];
  if (Array.isArray(streamers)) return readFrom(streamers[0]);
  return readFrom(streamers);
}

// デプロイ窓フォールバックで card_pack_names 列を落とした埋め込みを再構成する際、
// extractCardPackNames が常に空配列を安全に読めるよう明示的に空配列を注入する。


// PUT のオーナーシップ確認 SELECT（cards INNER JOIN streamers）が返す行の pg 直結形状。
// デプロイ窓フォールバックで card_pack_names / collection_name を落とした場合も
// 同じ形状（該当フィールドはフォールバック値）で返すことで、呼び出し側の再構成
// ロジックを1本化する。
interface CardOwnershipRowPg {
  streamer_id: string;
  image_url: string | null;
  rarity: string;
  is_active: boolean | null;
  intra_rarity_weight: number;
  collection_name: string | null;
  twitch_user_id: string;
  rarity_weights: Record<string, number> | null;
  card_pack_names: string[];
}

async function selectCardOwnershipFull(id: string): Promise<CardOwnershipRowPg | null> {
  const rows = await withDbRetry(
    async () => {
      // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
      const { db } = await getDb();
      return db
        .select({
          streamer_id: cardsTable.streamer_id,
          image_url: cardsTable.image_url,
          rarity: cardsTable.rarity,
          is_active: cardsTable.is_active,
          intra_rarity_weight: cardsTable.intra_rarity_weight,
          collection_name: cardsTable.collection_name,
          twitch_user_id: streamersTable.twitch_user_id,
          rarity_weights: streamersTable.rarity_weights,
          card_pack_names: streamersTable.card_pack_names,
        })
        .from(cardsTable)
        .innerJoin(streamersTable, eq(streamersTable.id, cardsTable.streamer_id))
        .where(eq(cardsTable.id, id))
        .limit(1);
    },
    "Cards API PUT: ownership check",
    { idempotent: true }
  );
  return rows[0] ?? null;
}

async function selectCardOwnershipWithoutCardPackNames(id: string): Promise<CardOwnershipRowPg | null> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          streamer_id: cardsTable.streamer_id,
          image_url: cardsTable.image_url,
          rarity: cardsTable.rarity,
          is_active: cardsTable.is_active,
          intra_rarity_weight: cardsTable.intra_rarity_weight,
          collection_name: cardsTable.collection_name,
          twitch_user_id: streamersTable.twitch_user_id,
          rarity_weights: streamersTable.rarity_weights,
        })
        .from(cardsTable)
        .innerJoin(streamersTable, eq(streamersTable.id, cardsTable.streamer_id))
        .where(eq(cardsTable.id, id))
        .limit(1);
    },
    "Cards API PUT: ownership check (retry without card_pack_names)",
    { idempotent: true }
  );
  const row = rows[0];
  return row ? { ...row, card_pack_names: [] } : null;
}

async function selectCardOwnershipWithoutCollectionAndPackNames(id: string): Promise<CardOwnershipRowPg | null> {
  const rows = await withDbRetry(
    async () => {
      const { db } = await getDb();
      return db
        .select({
          streamer_id: cardsTable.streamer_id,
          image_url: cardsTable.image_url,
          rarity: cardsTable.rarity,
          is_active: cardsTable.is_active,
          intra_rarity_weight: cardsTable.intra_rarity_weight,
          twitch_user_id: streamersTable.twitch_user_id,
          rarity_weights: streamersTable.rarity_weights,
        })
        .from(cardsTable)
        .innerJoin(streamersTable, eq(streamersTable.id, cardsTable.streamer_id))
        .where(eq(cardsTable.id, id))
        .limit(1);
    },
    "Cards API PUT: ownership check (retry without card_pack_names/collection_name)",
    { idempotent: true }
  );
  const row = rows[0];
  return row ? { ...row, collection_name: null, card_pack_names: [] } : null;
}

/**
 * PUT /api/cards/[id] のオーナーシップ確認 SELECT（cards INNER JOIN streamers、
 * card_pack_names → collection_name の2段階デプロイ窓フォールバック付き）の
 * pg 直結実装 (#663, #954 collection_name残置)。
 *
 * - `streamers!cards_streamer_id_fkey!inner(...)` は
 *   `.innerJoin(streamersTable, eq(streamersTable.id, cardsTable.streamer_id))`
 *   が等価（FK: streamers.id = cards.streamer_id 上の INNER JOIN）。
 * - 取得した行は既存の extractTwitchUserId/extractRarityWeights/
 *   extractCardPackNames ヘルパーがそのまま使えるよう、
 *   `{ ...cardFields, streamers: { twitch_user_id, rarity_weights, card_pack_names } }`
 *   の同じネスト形状に再構成する。
 * - 想定外のエラーを含め、いずれの取得も最終的に失敗した場合は throw せず
 *   `!card` だけで 403 に倒しており（cardSelectError は「フォールバック判定」
 *   にのみ使われる）、同じ外部挙動に合わせるため。
 */
async function fetchCardForUpdatePg(id: string): Promise<{
  card: {
    streamer_id: string;
    image_url: string | null;
    rarity: string;
    is_active: boolean | null;
    intra_rarity_weight: number;
    collection_name: string | null;
    streamers: { twitch_user_id: string; rarity_weights: Record<string, number> | null; card_pack_names: string[] };
  } | null;
  cardPackNamesUnavailable: boolean;
}> {
  let cardPackNamesUnavailable = false;
  let row: CardOwnershipRowPg | null = null;
  let currentError: unknown = null;

  try {
    row = await selectCardOwnershipFull(id);
  } catch (error) {
    currentError = error;
  }

  // Issue #393再設計: card_pack_names(事前登録パック一覧、streamers埋め込み内)
  // がデプロイ窓で未検出の場合、それだけ外して再試行する。
  if (currentError && isMissingCardPackNamesColumnError(currentError as CardsSchemaError)) {
    cardPackNamesUnavailable = true;
    currentError = null;
    try {
      row = await selectCardOwnershipWithoutCardPackNames(id);
    } catch (error) {
      currentError = error;
    }
  }

  // collection_name は #834 実測対象外のため、デプロイ窓フォールバックを残す。
  // migration 00061 で適用済みだが、確実性のため残置。#954 実測で撤去可否を判断する。
  if (currentError && isMissingCollectionNameColumn(currentError as CardsSchemaError)) {
    currentError = null;
    try {
      row = await selectCardOwnershipWithoutCollectionAndPackNames(id);
    } catch (error) {
      currentError = error;
    }
  }


  if (currentError || !row) {
    return { card: null, cardPackNamesUnavailable };
  }

  return {
    card: {
      streamer_id: row.streamer_id,
      image_url: row.image_url,
      rarity: row.rarity,
      is_active: row.is_active,
      intra_rarity_weight: row.intra_rarity_weight,
      collection_name: row.collection_name,
      streamers: {
        twitch_user_id: row.twitch_user_id,
        rarity_weights: row.rarity_weights,
        card_pack_names: row.card_pack_names,
      },
    },
    cardPackNamesUnavailable,
  };
}

/**
 * PUT /api/cards/[id] のカード UPDATE（max_issuance_count →
 * collection_name の2段階デプロイ窓フォールバック付き、さらに RETURNING 列の
 * image_padding_color フォールバックを末尾に追加）の pg 直結実装 (#663 self-review fix, #954 card_number撤去)。
 *
 * - `.update(...).eq("id", id).select().maybeSingle()` は
 *   `.update(...).set(...).where(eq(id, ...)).returning()` が等価。
 * - ON CONFLICT の無い INSERT のため各試行は非冪等（withDbRetry にオプションを渡さない = リトライなし）。
 * - リクエストボディの明示的な最終値を書き込む UPDATE のため冪等（リトライ可）。
 * - unique_violation (23505) は呼び出し元(PUT)で isCardNumberConflictError
 *
 * #834: 「本番未デプロイ8列」（card_number/hp/atk/def/spd/skill_*）に対する
 * RETURNING フォールバックは、本番実測で8列とも実在することを確認したため撤去
 * した。card_number は同実測で実在確認済み（#834）のため、そのフォールバックは不要。
 * max_issuance_count / collection_name は #834 実測対象外のためフォールバックを残す。
 * image_padding_color（#899、本Issueとは独立した別デプロイ窓）は無指定 `.returning()` が
 * 失敗しうるため、CARDS_COLUMNS_WITHOUT_PADDING_COLOR へ切り替えて最後に一度だけ再試行
 * する（updateData に無い場合も RETURNING は set() の内容と無関係に schema.ts の
 * 全列を要求するため、この最終フォールバックが必要）。
 */
async function updateCardPg(
  id: string,
  updateDataInitial: Record<string, unknown>
): Promise<{ updatedCard: Record<string, unknown> | null; error: unknown }> {
  const updateData = { ...updateDataInitial };

  async function attemptUpdate(
    useColumnsWithoutPaddingColor = false
  ): Promise<{ updatedCard: Record<string, unknown> | null; error: unknown }> {
    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          const query = db
            .update(cardsTable)
            .set(updateData as Partial<typeof cardsTable.$inferInsert>)
            .where(eq(cardsTable.id, id));
          return useColumnsWithoutPaddingColor
            ? query.returning(CARDS_COLUMNS_WITHOUT_PADDING_COLOR)
            : query.returning();
        },
        "Cards API PUT: update card",
        // 明示的な最終値を書く UPDATE のため冪等（リトライ可）
        { idempotent: true }
      );
      return { updatedCard: rows[0] ?? null, error: null };
    } catch (error) {
      return { updatedCard: null, error };
    }
  }

  let { updatedCard, error } = await attemptUpdate();

  // max_issuance_count は #834 実測対象外（#834 実測8列: card_number/hp/atk/def/spd/skill_*）ため、
  // デプロイ窓フォールバックを残す。本番・preview 実測済み（#834 対象外だが migration 00067 適用済み）だが、
  // 確実性のため残置。#954 実測で撤去可否を判断する。
  if (error && isMissingCardIssuanceColumnError(error) && "max_issuance_count" in updateData) {
    delete updateData.max_issuance_count;
    ({ updatedCard, error } = await attemptUpdate());
  }
  // collection_name は #834 実測対象外のため、デプロイ窓フォールバックを残す。
  // migration 00061 で適用済みだが、確実性のため残置。#954 実測で撤去可否を判断する。
  if (error && isMissingCollectionNameColumn(error as CardsSchemaError) && "collection_name" in updateData) {
    delete updateData.collection_name;
    ({ updatedCard, error } = await attemptUpdate());
  }
  // #899: image_padding_color 列が migration 未適用の環境では、この列を落として再試行する
  //（余白情報だけが更新されず、カード更新自体は継続する）
  if (error && isMissingCardPaddingColorError(error) && "image_padding_color" in updateData) {
    delete updateData.image_padding_color;
    ({ updatedCard, error } = await attemptUpdate());
  }
  // 上記までの入力値フォールバックを尽くしてもなお、無指定 RETURNING が
  // image_padding_color 列の欠落で失敗している場合、明示列リストで最後にもう
  // 一度だけ試す。image_padding_color が updateData に無い場合（未指定
  // リクエスト）は直前のフォールバックの `"image_padding_color" in updateData`
  // 条件を満たさずスキップされるため、この分岐が無いと migration 未適用の
  // 環境では imagePaddingColor を送らないカード更新まで含めて全滅していた
  // （#899 Fable厳格レビュー指摘・PR #903）。
  if (error && isMissingCardPaddingColorError(error)) {
    ({ updatedCard, error } = await attemptUpdate(true));
  }

  return { updatedCard, error };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: csrfValidation.error || ERROR_MESSAGES.FORBIDDEN, code: 'CSRF_VALIDATION_FAILED' },
      { status: 403 }
    )
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsId, identifier);

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

  const { id } = await params;

  try {

    const body = await request.json();
    const { name, description, imageUrl, rarity, dropRate, isActive, intraRarityWeight, cardNumber, maxIssuanceCount, imagePaddingColor, tradeWantable } = body;

    // #1790: 「求めるカードに指定できる」(cards.trade_wantable)。省略時は変更しない。
    // 真偽値以外（文字列 "false" 等）を truthy/falsy で解釈すると意図と逆の値を
    // 保存しうるため、boolean だけを受け付ける。
    if (tradeWantable !== undefined && typeof tradeWantable !== "boolean") {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    // Issue #393: optional card pack name (null clears it = all cards).
    const collectionNameResult = resolveCollectionNameField(body, "collectionName");
    if (!collectionNameResult.ok) {
      return NextResponse.json({ error: ERROR_MESSAGES.INVALID_REQUEST }, { status: 400 });
    }

    if (name !== undefined) {
      const nameValidation = validateCardName(name)
      if (!nameValidation.valid) {
        return NextResponse.json(
          { error: nameValidation.error },
          { status: 400 }
        )
      }
    }

    if (description !== undefined) {
      const descriptionValidation = validateCardDescription(description)
      if (!descriptionValidation.valid) {
        return NextResponse.json(
          { error: descriptionValidation.error },
          { status: 400 }
        )
      }
    }

    if (imageUrl !== undefined) {
      const imageUrlValidation = validateImageUrl(imageUrl)
      if (!imageUrlValidation.valid) {
        return NextResponse.json(
          { error: imageUrlValidation.error },
          { status: 400 }
        )
      }
    }

    if (rarity !== undefined) {
      const rarityValidation = validateRarity(rarity)
      if (!rarityValidation.valid) {
        return NextResponse.json(
          { error: rarityValidation.error },
          { status: 400 }
        )
      }
    }

    // #899: 余白（fit）モードの色はホワイトリスト検証（表示側の CSS 背景色に使うため）
    if (imagePaddingColor !== undefined) {
      const paddingColorValidation = validateImagePaddingColor(imagePaddingColor)
      if (!paddingColorValidation.valid) {
        return NextResponse.json(
          { error: paddingColorValidation.error },
          { status: 400 }
        )
      }
    }

    if (dropRate !== undefined) {
      if (typeof dropRate !== "number" || dropRate < 0 || dropRate > 1) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.DROP_RATE_INVALID },
          { status: 400 }
        );
      }
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

    // intraRarityWeight は正の数値のみ許可
    if (intraRarityWeight !== undefined) {
      if (typeof intraRarityWeight !== "number" || !Number.isFinite(intraRarityWeight) || intraRarityWeight <= 0) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.INTRA_RARITY_WEIGHT_INVALID },
          { status: 400 }
        );
      }
    }

    // Verify ownership and get current image_url for cleanup
    // 所有権を確認し、クリーンアップ用に現在のimage_urlを取得
    const cardLookup = await fetchCardForUpdatePg(id);
    const card = cardLookup.card;
    const cardPackNamesUnavailable = cardLookup.cardPackNamesUnavailable;

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Delete old image if imageUrl is being changed to a different URL
    // imageUrlが異なるURLに変更される場合、古い画像を削除
    const oldImageUrl = card.image_url;
    const isImageChanging = imageUrl !== undefined && imageUrl !== oldImageUrl;

    // #830: 他人のストレージURLを自分のカードへ紐付けることを禁止する。
    // 紐付けを許すと、以降の差し替え・カード削除のクリーンアップで他人の
    // オブジェクトが削除される。判定は「URLが実際に変わるとき」だけに限定する。
    // 既存値の再送信（画像以外のフィールド編集）は判定対象外なので、所有権を
    // 判定できないURLを持つ既存カードでも編集が止まらない。
    if (isImageChanging && !(await isAssignableImageUrl(imageUrl, session.twitchUserId))) {
      logger.warn(
        `Cards API: rejected foreign storage image URL on update by user ${session.twitchUserId}: ${imageUrl}`
      );
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Issue #393再設計: パック紐付けの変更は、値が実際に変わる場合のみ
    // 事前登録済み(card_pack_names)であることを要求する(#269のプレミアム
    // ゲートは廃止。パック管理モーダルでの追加時のみゲートする設計に変更)。
    // null化・現在値の再送信は常に許可 — パック削除後の孤立参照でも壊れない。
    const registeredPackNames = extractCardPackNames(card.streamers);
    const collectionNameIsNewNonNullValue =
      collectionNameResult.value !== undefined &&
      collectionNameResult.value !== null &&
      collectionNameResult.value !== card.collection_name;

    if (collectionNameIsNewNonNullValue && !cardPackNamesUnavailable) {
      if (!isRegisteredOrUnchanged(collectionNameResult.value as string, card.collection_name, registeredPackNames)) {
        return NextResponse.json({ error: ERROR_MESSAGES.COLLECTION_NOT_REGISTERED }, { status: 400 });
      }
    }

    // デプロイ窓でmembership検証ができない間は、新しいパック紐付けの書き込み
    // 自体を見送る(他フィールドの更新は妨げない)。
    const collectionNameSkippedDeployWindow = collectionNameIsNewNonNullValue && cardPackNamesUnavailable;

    const rarityWeights = extractRarityWeights(card.streamers);
    const rarityChanged = rarity !== undefined && rarity !== card.rarity;
    const activeChanged = isActive !== undefined && isActive !== card.is_active;
    // 値が実際に変わった場合のみ再計算（リクエストに存在するだけでは不十分）
    const intraWeightChanged = intraRarityWeight !== undefined && intraRarityWeight !== (card.intra_rarity_weight ?? 1.0);
    const shouldRecalculate = rarityWeights !== null && (rarityChanged || activeChanged || intraWeightChanged);

    // NOTE: Drop rate validation removed because the system uses relative weights
    // The actual probability is calculated as: this_card_weight / total_weights
    // So there's no need to limit the sum to 100% - weights are relative, not absolute percentages
    // 注意: ドロップレート検証を削除。システムは相対重みを使用するため
    // 実際の確率は「このカードの重み / 全体の重み」で計算される
    // 重みは相対的であり絶対的な割合ではないため、合計100%制限は不要

    // 更新するフィールドを動的に構築（undefined のフィールドは更新しない）
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (imageUrl !== undefined) updateData.image_url = imageUrl;
    // Issue #899: 余白（fit）モードの余白色（null は余白なしへ戻す、"" も同様にクリア）
    if (imagePaddingColor !== undefined) updateData.image_padding_color = imagePaddingColor === "" ? null : imagePaddingColor;
    if (rarity !== undefined) updateData.rarity = typeof rarity === "string" ? rarity.trim() : rarity;
    if (collectionNameResult.value !== undefined && !collectionNameSkippedDeployWindow) updateData.collection_name = collectionNameResult.value;
    if (cardNumber !== undefined) updateData.card_number = cardNumber;
    if (maxIssuanceCount !== undefined) updateData.max_issuance_count = parsedIssuanceLimit;
    if (dropRate !== undefined) updateData.drop_rate = dropRate;
    if (intraRarityWeight !== undefined) updateData.intra_rarity_weight = intraRarityWeight;
    if (isActive !== undefined) updateData.is_active = isActive;

    // #1790: tradeWantable だけを送る要求では本体の UPDATE を行わない
    // （空の set() は Drizzle が例外にする）。現在の本体行は返さず、
    // id と trade_wantable だけを返す。
    const tradeWantableOnly = tradeWantable !== undefined && Object.keys(updateData).length === 0;
    const { updatedCard, error } = tradeWantableOnly
      ? { updatedCard: { id } as Record<string, unknown>, error: null }
      : await updateCardPg(id, updateData);

    if (error) {
      const rewardPack = getRewardCardProtectionPack(error);
      if (rewardPack !== null) {
        const tReward = await getTranslations('packCompletionReward');
        return NextResponse.json({ error: tReward('activateBlocked', { packName: rewardPack === '__default__' ? tReward('defaultPack') : rewardPack }), code: 'PACK_COMPLETION_REWARD_CARD', packName: rewardPack }, { status: 409 });
      }
      if (isCardNumberConflictError(error)) {
        return NextResponse.json(
          { error: CARD_NUMBER_MESSAGES.duplicate },
          { status: 409 }
        );
      }
      return handleDatabaseError(error, "Failed to update card");
    }

    // #1790: trade_wantable は cards 本体の Drizzle 定義に無い列のため
    // （src/lib/db/schema.ts の cardTradeSettings 参照）、本体の UPDATE の後に
    // 別の UPDATE で書く。所有者の認可は上の所有権確認（このカードの配信者
    // 本人であること）がそのまま担保する。
    //   - 本体の UPDATE が失敗した場合（409 等）は上で return 済みで、ここへは
    //     来ない。本体だけ成功してこちらが失敗した場合は 500 になるが、どちらも
    //     明示的な最終値を書く冪等な UPDATE なので、同じ内容の再送で収束する。
    //   - 応答の trade_wantable は tradeWantable を送った要求にだけ含める。
    //     CardManager は指定可否をカード行とは別の state で持ち、この値で更新する
    //     （カード行は本体の無指定 RETURNING 等で丸ごと置き換わるため）。
    let tradeWantableSkippedDeployWindow = false;
    let tradeWantableResult: boolean | undefined;
    if (updatedCard && tradeWantable !== undefined) {
      const written = await updateCardTradeWantable(id, tradeWantable);
      if (written === "column_missing") {
        // デプロイ窓: 列が無い = 全カード指定可。指定不可は保存できない。
        tradeWantableSkippedDeployWindow = tradeWantable === false;
        tradeWantableResult = true;
      } else if (written === null) {
        // 並行削除: 本体の UPDATE と同じく 0 行更新。値は応答に載せない。
        tradeWantableResult = undefined;
      } else {
        tradeWantableResult = written.trade_wantable;
        // GET /api/cards は unstable_cache（TTL 30秒）で trade_wantable を含む
        // 一覧を返す。無効化しないと、保存直後の CardManager の再読み込み
        // （並び替え・フィルター変更）が古い値を受け取り、トグルが保存前の
        // 状態に戻って見える。古い値のまま別の編集を保存すると制限が意図せず
        // 外れうる（CardManager 側でも未変更なら送らないが、表示も正しく保つ）。
        // revalidateTag の使い方は pack-completion-rewards と同じ（即時失効）。
        revalidateTag(cardsListCacheTag(card.streamer_id), { expire: 0 });
      }
    }

    // 旧画像のクリーンアップ (#830: 所有権検証は deleteOwnedStorageImage が担当)
    // UPDATE が実際に行を更新したあとに実行する。先に削除すると、card_number
    // 重複(409)などで UPDATE が失敗したときにカードが旧URLを参照したまま実体
    // だけが消える。updatedCard が null = 0行更新（並行削除など）も同様に
    // 新しい image_url が永続化されていないため削除しない。
    // 削除失敗はカード更新を妨げない（ログのみ）。
    if (updatedCard && isImageChanging && oldImageUrl) {
      try {
        await deleteOwnedStorageImage(oldImageUrl, session.twitchUserId, "Cards API (update)");
      } catch (storageError) {
        logger.warn(`Failed to delete old storage image: ${oldImageUrl}`, storageError);
      }
    }

    // 再計算はベストエフォート: カード更新は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    if (shouldRecalculate) {
      try {
        recalculatedCards = await recalculateIfAutoMode(
          card.streamer_id,
          rarityWeights
        );
      } catch (recalculationError) {
        logger.error("Cards API: Recalculation failed after card update", recalculationError);
      }
    }

    return NextResponse.json({
      ...updatedCard,
      ...(tradeWantableResult !== undefined ? { trade_wantable: tradeWantableResult } : {}),
      recalculatedCards,
      ...(collectionNameSkippedDeployWindow ? { collectionNameSkippedDeployWindow: true } : {}),
      ...(tradeWantableSkippedDeployWindow ? { tradeWantableSkippedDeployWindow: true } : {}),
    });
  } catch (error) {
    return handleApiError(error, "Cards API: PUT");
  }
}

/**
 * DELETE /api/cards/[id] のオーナーシップ確認 SELECT（cards INNER JOIN
 * streamers、フォールバックチェーン無し）の pg 直結実装 (#663)。
 *
 *   （`const { data: card } = await ...`）ため、いかなるエラーも `!card` の
 *   403 分岐に落ちる。pg 版も同じ外部挙動に合わせ、throw せず null を返す。
 */
async function selectCardOwnershipForDeletePg(
  id: string
): Promise<{ streamer_id: string; image_url: string | null; streamers: { twitch_user_id: string; rarity_weights: Record<string, number> | null } } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({
            streamer_id: cardsTable.streamer_id,
            image_url: cardsTable.image_url,
            twitch_user_id: streamersTable.twitch_user_id,
            rarity_weights: streamersTable.rarity_weights,
          })
          .from(cardsTable)
          .innerJoin(streamersTable, eq(streamersTable.id, cardsTable.streamer_id))
          .where(eq(cardsTable.id, id))
          .limit(1);
      },
      "Cards API DELETE: ownership check",
      { idempotent: true }
    );
    const row = rows[0];
    if (!row) return null;
    return {
      streamer_id: row.streamer_id,
      image_url: row.image_url,
      streamers: { twitch_user_id: row.twitch_user_id, rarity_weights: row.rarity_weights },
    };
  } catch {
    return null;
  }
}

/**
 * DELETE /api/cards/[id] の DELETE 文の pg 直結実装 (#663)。
 * PK（id）指定の DELETE は再実行しても最終状態が同じため冪等（リトライ可）。
 * removeBlobFilePg の DELETE と同じ方針（src/lib/storage-db.ts 参照）。
 */
async function deleteCardPg(id: string): Promise<{ error: unknown }> {
  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db.delete(cardsTable).where(eq(cardsTable.id, id));
      },
      "Cards API DELETE: delete card",
      { idempotent: true }
    );
    return { error: null };
  } catch (error) {
    return { error };
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: csrfValidation.error || ERROR_MESSAGES.FORBIDDEN, code: 'CSRF_VALIDATION_FAILED' },
      { status: 403 }
    )
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.cardsId, identifier);

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

  const { id } = await params;

  try {


    // Get card with image_url for deletion
    // 削除用にimage_url付きでカードを取得
    const card = await selectCardOwnershipForDeletePg(id);

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Delete image from storage if it exists
    // ストレージから画像を削除（#830: 所有権検証は deleteOwnedStorageImage が担当）
    // Log but don't fail the card deletion if storage deletion fails
    // ストレージ削除が失敗してもカード削除は続行（ログのみ記録）
    if (card.image_url) {
      try {
        await deleteOwnedStorageImage(card.image_url, session.twitchUserId, "Cards API (delete)");
      } catch (storageError) {
        logger.warn(`Failed to delete storage image: ${card.image_url}`, storageError);
      }
    }

    const { error } = await deleteCardPg(id);

    if (error) {
      return handleDatabaseError(error, "Failed to delete card");
    }

    // 再計算はベストエフォート: カード削除は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    const rarityWeights = extractRarityWeights(card.streamers);
    if (rarityWeights !== null) {
      try {
        recalculatedCards = await recalculateIfAutoMode(
          card.streamer_id,
          rarityWeights
        );
      } catch (recalculationError) {
        logger.error("Cards API: Recalculation failed after card deletion", recalculationError);
      }
    }

    return NextResponse.json({ success: true, recalculatedCards });
  } catch (error) {
    return handleApiError(error, "Cards API: DELETE");
  }
}
