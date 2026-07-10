import { NextRequest, NextResponse } from "next/server";
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
import { extractTwitchUserId } from "@/types/database";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { logger } from "@/lib/logger";
import { deleteFromR2 } from "@/lib/r2-client";
import { removeBlobFile } from "@/lib/storage-db";
import { isR2Url, isVercelBlobUrl, isStorageUrl, getR2KeyFromUrl } from "@/lib/storage-utils";
import { recalculateIfAutoMode } from "@/lib/recalculate-drop-rates";
import { CARD_NUMBER_MESSAGES, isCardNumberConflictError, isMissingCardNumberColumnError } from "@/lib/card-number-errors";
import { CARD_ISSUANCE_MESSAGES, isMissingCardIssuanceColumnError, parseCardIssuanceLimit } from "@/lib/card-issuance";
import { resolveCollectionNameField, isRegisteredOrUnchanged } from "@/lib/validation/collection-name";
import { isMissingCollectionNameColumn, isMissingCardPackNamesColumnError } from "@/lib/collections/collection-existence";
import type { ApiRateLimitResponse } from "@/types/api";
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。PUT/DELETE はいずれも cards への
// 書き込み(UPDATE/DELETE)を含むため、所有権確認(streamers 埋め込み込みの select)
// も含めたリクエスト内の全 DB アクセスを isPgWriteEnabled() で分岐する
// (読み書きで経路が混ざると障害切り分けが困難になるため。battle/start route と
// 同じ判断)。フラグ未設定時(既定 'postgrest')はこれらのモジュールの実行パスに
// 一切入らないため、import が存在するだけでは挙動に影響しない(tests/setup.ts の
// getDb throw スタブが「postgrest 経路で getDb が呼ばれない」ことを構造的に
// 保証)。
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgWriteEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable, streamers as streamersTable } from "@/lib/db/schema";

type MissingColumnErrorShape = { message?: string; code?: string; hint?: string };

/**
 * PUT /api/cards/[id] の所有権確認 select(streamers 埋め込み込み)の
 * pg 直結実装 (#663)。
 *
 * PostgREST 実装との対応:
 * - `streamers!cards_streamer_id_fkey!inner(...)` の to-one 埋め込みは、
 *   cards ⋈ streamers (ON cards.streamer_id = streamers.id) の INNER JOIN が
 *   等価(FK 制約(migration 00001)そのものが JOIN 条件)。cards.id は PK のため
 *   LIMIT 1 + rows[0] ?? null が .maybeSingle() と同じ外部挙動。
 * - card_pack_names / collection_name 列未デプロイ時のカスケードフォールバックは
 *   既存実装と同じ判定関数(isMissingCardPackNamesColumnError /
 *   isMissingCollectionNameColumn)をそのまま再利用する(message 文字列一致で
 *   成立するため postgres.js のネイティブ 42703 エラーにも機能する。
 *   POST /api/cards の insertCardPg doc コメント参照)。
 * - 列未デプロイ以外のエラー(その他の select 失敗)は既存実装と同じく区別せず
 *   card=null 扱いにする(既存実装が `!card` だけで 403 判定しているため)。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
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
  const selectFull = () =>
    withDbRetry(
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
            s_twitch_user_id: streamersTable.twitch_user_id,
            s_rarity_weights: streamersTable.rarity_weights,
            s_card_pack_names: streamersTable.card_pack_names,
          })
          .from(cardsTable)
          .innerJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
          .where(eq(cardsTable.id, id))
          .limit(1);
      },
      "Cards API: PUT ownership select(pg)",
      { idempotent: true }
    );

  const selectWithoutCardPackNames = () =>
    withDbRetry(
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
            s_twitch_user_id: streamersTable.twitch_user_id,
            s_rarity_weights: streamersTable.rarity_weights,
          })
          .from(cardsTable)
          .innerJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
          .where(eq(cardsTable.id, id))
          .limit(1);
      },
      "Cards API: PUT ownership select fallback(card_pack_names,pg)",
      { idempotent: true }
    );

  const selectWithoutCollectionAndPackNames = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            streamer_id: cardsTable.streamer_id,
            image_url: cardsTable.image_url,
            rarity: cardsTable.rarity,
            is_active: cardsTable.is_active,
            intra_rarity_weight: cardsTable.intra_rarity_weight,
            s_twitch_user_id: streamersTable.twitch_user_id,
            s_rarity_weights: streamersTable.rarity_weights,
          })
          .from(cardsTable)
          .innerJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
          .where(eq(cardsTable.id, id))
          .limit(1);
      },
      "Cards API: PUT ownership select fallback(collection_name,pg)",
      { idempotent: true }
    );

  let cardPackNamesUnavailable = false;
  let row:
    | {
        streamer_id: string;
        image_url: string | null;
        rarity: string;
        is_active: boolean | null;
        intra_rarity_weight: number;
        collection_name?: string | null;
        s_twitch_user_id: string;
        s_rarity_weights: Record<string, number> | null;
        s_card_pack_names?: string[] | null;
      }
    | undefined;
  let lastError: unknown = null;

  try {
    row = (await selectFull())[0];
  } catch (error) {
    lastError = error;
  }

  if (lastError && isMissingCardPackNamesColumnError(lastError as MissingColumnErrorShape)) {
    cardPackNamesUnavailable = true;
    try {
      row = (await selectWithoutCardPackNames())[0];
      lastError = null;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError && isMissingCollectionNameColumn(lastError as MissingColumnErrorShape)) {
    cardPackNamesUnavailable = true;
    try {
      row = (await selectWithoutCollectionAndPackNames())[0];
      lastError = null;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError || !row) {
    return { card: null, cardPackNamesUnavailable };
  }

  return {
    card: {
      streamer_id: row.streamer_id,
      image_url: row.image_url,
      rarity: row.rarity,
      is_active: row.is_active,
      intra_rarity_weight: row.intra_rarity_weight,
      collection_name: row.collection_name ?? null,
      streamers: {
        twitch_user_id: row.s_twitch_user_id,
        rarity_weights: row.s_rarity_weights,
        card_pack_names: row.s_card_pack_names ?? [],
      },
    },
    cardPackNamesUnavailable,
  };
}

/**
 * PUT /api/cards/[id] の cards UPDATE の pg 直結実装 (#663)。
 *
 * PostgREST 実装との対応:
 * - .update(updateData).eq("id", id).select().maybeSingle() は「更新行の全列を
 *   返す」ため、Drizzle の .returning()(引数なし = 全列)+ rows[0] ?? null が
 *   同じ外部挙動(0 行更新 = 対象カードが既に削除された等)。
 * - card_number / max_issuance_count / collection_name 列の未デプロイ時カスケード
 *   リトライは POST /api/cards の insertCardPg と同じ判定関数・同じ順序を使う。
 *
 * 冪等性判断(リトライ可 — POST の insertCardPg と異なる判断): updateData は
 * 呼び出し元でリクエストボディから一度だけ構築される「値の直接代入」のみで
 * 構成され(カウンタ加算や一度きりの状態遷移を含まない)、queryFn の外
 * (呼び出し元)で事前計算済みの値を書く UPDATE である。1 回目が実際には
 * コミット済みで応答だけ接続断で失われた場合でも、同一引数での再実行は同じ行に
 * 同じ値を再代入するだけで収束先の状態は変わらない(cards.updated_at の
 * BEFORE UPDATE トリガー(migration 00001)によるタイムスタンプのみ再実行ごとに
 * 前進するが、呼び出し元はこの値を検証しない。executeBatchUpdateCardDropRatesRpcPg
 * の doc コメントと同種の許容可能な副作用)。よって idempotent: true として
 * 接続断リトライを許可する。
 */
async function updateCardPg(
  id: string,
  updateData: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; error: unknown }> {
  const data = { ...updateData };
  let result: Record<string, unknown> | null = null;
  let lastError: unknown = null;

  const tryUpdate = async (): Promise<void> => {
    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db.update(cardsTable).set(data as never).where(eq(cardsTable.id, id)).returning();
        },
        "Cards API: PUT update card(pg)",
        // 事前計算した同じ値を書く UPDATE のためリトライしても冪等(上記 doc コメント参照)
        { idempotent: true }
      );
      result = rows[0] ?? null;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
  };

  await tryUpdate();

  if (lastError && isMissingCardNumberColumnError(lastError) && "card_number" in data) {
    delete data.card_number;
    await tryUpdate();
  }
  if (lastError && isMissingCardIssuanceColumnError(lastError) && "max_issuance_count" in data) {
    delete data.max_issuance_count;
    await tryUpdate();
  }
  if (lastError && isMissingCollectionNameColumn(lastError as MissingColumnErrorShape) && "collection_name" in data) {
    delete data.collection_name;
    await tryUpdate();
  }

  return { data: result, error: lastError };
}

/**
 * DELETE /api/cards/[id] の所有権確認 select(streamers 埋め込み込み)の
 * pg 直結実装 (#663)。既存実装はこの select に列未デプロイフォールバックを
 * 持たないため(collection_name / card_pack_names を選択しない)、pg 版も
 * カスケードフォールバック無しの単純な INNER JOIN + LIMIT 1 で対応する。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 * 取得失敗は既存実装と同じく区別せず card=null 扱いにする(`!card` だけで
 * 403 判定しているため)。
 */
async function fetchCardForDeletePg(id: string): Promise<{
  streamer_id: string;
  image_url: string | null;
  streamers: { twitch_user_id: string; rarity_weights: Record<string, number> | null };
} | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            streamer_id: cardsTable.streamer_id,
            image_url: cardsTable.image_url,
            s_twitch_user_id: streamersTable.twitch_user_id,
            s_rarity_weights: streamersTable.rarity_weights,
          })
          .from(cardsTable)
          .innerJoin(streamersTable, eq(cardsTable.streamer_id, streamersTable.id))
          .where(eq(cardsTable.id, id))
          .limit(1);
      },
      "Cards API: DELETE ownership select(pg)",
      { idempotent: true }
    );
    const row = rows[0];
    if (!row) return null;
    return {
      streamer_id: row.streamer_id,
      image_url: row.image_url,
      streamers: { twitch_user_id: row.s_twitch_user_id, rarity_weights: row.s_rarity_weights },
    };
  } catch {
    return null;
  }
}

/**
 * DELETE /api/cards/[id] の cards DELETE の pg 直結実装 (#663)。
 *
 * 冪等性判断(リトライ可 — POST の insertCardPg と異なる判断): 既存実装は
 * PK(id)指定の DELETE で対象行数を検証しない(0 行削除でもエラーにしない —
 * 下の DELETE ハンドラの `const { error } = ...; if (error) {...}` を参照。
 * 行が実際に削除されたかどうかを問わない)。そのため 1 回目が実際にはコミット
 * 済みで応答だけ接続断で失われた場合、同一 id での再実行は 0 行削除になるだけで
 * エラーにならず、レスポンス(success:true)も変わらない — removeBlobFile の
 * doc コメントと同じ「PK 指定の DELETE は再実行しても最終状態が同じ」ロジック。
 * よって idempotent: true として接続断リトライを許可する。
 */
async function deleteCardPg(id: string): Promise<{ error: unknown }> {
  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db.delete(cardsTable).where(eq(cardsTable.id, id));
      },
      "Cards API: DELETE card(pg)",
      { idempotent: true }
    );
    return { error: null };
  } catch (error) {
    return { error };
  }
}

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
function withEmptyCardPackNames(streamers: unknown): unknown {
  if (Array.isArray(streamers)) {
    return streamers.map((entry) =>
      entry && typeof entry === "object" ? { ...entry, card_pack_names: [] } : entry
    );
  }
  if (streamers && typeof streamers === "object") {
    return { ...streamers, card_pack_names: [] };
  }
  return streamers;
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

  const { id } = await params;

  try {
    // #663: cards への UPDATE(書き込み)を含むハンドラのため、以降の全 DB
    // アクセスを usePgWrite で分岐する(ファイル冒頭のコメント参照)。判定は
    // ここで 1 回だけ行って固定し、リクエスト処理の途中で環境変数が変わっても
    // 経路が混在しないようにする(battle/start route と同じ設計)。
    const usePgWrite = isPgWriteEnabled();

    const supabaseAdmin = getSupabaseAdmin();
    const body = await request.json();
    const { name, description, imageUrl, rarity, dropRate, isActive, intraRarityWeight, cardNumber, maxIssuanceCount } = body;

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
    //
    // #663: pg 経路(usePgWrite)では fetchCardForUpdatePg に委譲する。postgrest
    // 経路は既存実装のまま(内側の変数名のみ card → cardData に変更。if/else
    // 分岐の外側で共有する card 変数とのシャドーイングを避けるための構造上の
    // 都合であり、クエリ・カスケードリトライの条件分岐ロジックは無変更)。
    let card:
      | {
          streamer_id: string;
          image_url: string | null;
          rarity: string;
          is_active: boolean | null;
          intra_rarity_weight: number;
          collection_name: string | null;
          streamers: unknown;
        }
      | null;
    let cardPackNamesUnavailable = false;

    if (usePgWrite) {
      const result = await fetchCardForUpdatePg(id);
      card = result.card;
      cardPackNamesUnavailable = result.cardPackNamesUnavailable;
    } else {
      let { data: cardData, error: cardSelectError } = await supabaseAdmin
        .from("cards")
        // streamers の埋め込みは FK 制約名で一意化する: migration 00051 の
        // card_owner_stats が cards↔streamers を m2m にも見せ、ヒントなしの
        // streamers(...) は PGRST201 で失敗するため。
        .select("streamer_id, image_url, rarity, is_active, intra_rarity_weight, collection_name, streamers!cards_streamer_id_fkey!inner(twitch_user_id, rarity_weights, card_pack_names)")
        .eq("id", id)
        .maybeSingle();

      // Issue #393再設計: card_pack_names(事前登録パック一覧、streamers埋め込み内)
      // がデプロイ窓で未検出の場合、それだけ外して再試行する(collection_nameは
      // 既に本番稼働済みの列のため、通常この組み合わせのみが発生する)。
      if (cardSelectError && isMissingCardPackNamesColumnError(cardSelectError)) {
        const retryResult = await supabaseAdmin
          .from("cards")
          .select("streamer_id, image_url, rarity, is_active, intra_rarity_weight, collection_name, streamers!cards_streamer_id_fkey!inner(twitch_user_id, rarity_weights)")
          .eq("id", id)
          .maybeSingle();
        cardData = retryResult.data
          ? ({ ...retryResult.data, streamers: withEmptyCardPackNames(retryResult.data.streamers) } as typeof cardData)
          : null;
        cardSelectError = retryResult.error;
        cardPackNamesUnavailable = true;
      }

      // Issue #269 (self-review fix): collection_name was added to this
      // ownership-check SELECT to read the current pack value for the gate
      // below. During the deploy window (migration 00061 not applied yet) that
      // turns the SELECT itself into a 42703 "column does not exist" error,
      // which would 403 EVERY card edit — not just pack-related ones — because
      // this branch only checked `!card`, not `error`. Retry without the
      // column so unrelated edits keep working; the gate then just sees no
      // current pack value (treated as null), matching every other #393
      // deploy-window fallback in this codebase. card_pack_names も併せて落とす
      // (両方同時に未デプロイという稀なケースの安全側対応)。
      if (cardSelectError && isMissingCollectionNameColumn(cardSelectError)) {
        const retryResult = await supabaseAdmin
          .from("cards")
          .select("streamer_id, image_url, rarity, is_active, intra_rarity_weight, streamers!cards_streamer_id_fkey!inner(twitch_user_id, rarity_weights)")
          .eq("id", id)
          .maybeSingle();
        cardData = retryResult.data
          ? ({
              ...retryResult.data,
              collection_name: null,
              streamers: withEmptyCardPackNames(retryResult.data.streamers),
            } as typeof cardData)
          : null;
        cardSelectError = retryResult.error;
        cardPackNamesUnavailable = true;
      }
      card = cardData;
    }

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
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
    if (rarity !== undefined) updateData.rarity = typeof rarity === "string" ? rarity.trim() : rarity;
    if (collectionNameResult.value !== undefined && !collectionNameSkippedDeployWindow) updateData.collection_name = collectionNameResult.value;
    if (cardNumber !== undefined) updateData.card_number = cardNumber;
    if (maxIssuanceCount !== undefined) updateData.max_issuance_count = parsedIssuanceLimit;
    if (dropRate !== undefined) updateData.drop_rate = dropRate;
    if (intraRarityWeight !== undefined) updateData.intra_rarity_weight = intraRarityWeight;
    if (isActive !== undefined) updateData.is_active = isActive;

    // Delete old image if imageUrl is being changed to a different URL
    // imageUrlが異なるURLに変更される場合、古い画像を削除
    const oldImageUrl = card.image_url;
    const isImageChanging = imageUrl !== undefined && imageUrl !== oldImageUrl;

    if (isImageChanging && oldImageUrl && isStorageUrl(oldImageUrl)) {
      // Remove from DB and update usage
      // DBから削除し使用量を更新
      try {
        await removeBlobFile(oldImageUrl);
      } catch (dbError) {
        logger.warn(`Failed to remove old image from DB: ${oldImageUrl}`, dbError);
      }

      // Delete from storage (R2)
      // ストレージから削除（R2）
      // Note: Vercel Blob deletion removed - only R2 is supported now
      // 注意: Vercel Blob削除を削除 - R2のみサポート
      try {
        if (isR2Url(oldImageUrl)) {
          const key = getR2KeyFromUrl(oldImageUrl);
          if (key) {
            await deleteFromR2(key);
            logger.info(`Deleted old R2 image on update: ${oldImageUrl}`);
          }
        } else if (isVercelBlobUrl(oldImageUrl)) {
          // Vercel Blob URLs are no longer actively deleted
          // Migration to R2 should have moved these files
          logger.warn(`Vercel Blob URL found but deletion skipped: ${oldImageUrl}`);
        }
      } catch (storageError) {
        logger.warn(`Failed to delete old storage image: ${oldImageUrl}`, storageError);
      }
    }

    // #663: pg 経路(usePgWrite)では updateCardPg に委譲する。postgrest 経路は
    // 既存実装のまま(内側の変数名のみ updatedCard → updatedCardData に変更。
    // if/else 分岐の外側で共有する updatedCard 変数とのシャドーイングを避ける
    // ための構造上の都合であり、クエリ・カスケードリトライの条件分岐ロジックは
    // 無変更)。
    let updatedCard: Record<string, unknown> | null;
    let error: unknown;

    if (usePgWrite) {
      const result = await updateCardPg(id, updateData);
      updatedCard = result.data;
      error = result.error;
    } else {
      let { data: updatedCardData, error: updateError } = await supabaseAdmin
        .from("cards")
        .update(updateData)
        .eq("id", id)
        .select()
        .maybeSingle();

      if (updateError && isMissingCardNumberColumnError(updateError) && "card_number" in updateData) {
        delete updateData.card_number;
        const retryResult = await supabaseAdmin
          .from("cards")
          .update(updateData)
          .eq("id", id)
          .select()
          .maybeSingle();
        updatedCardData = retryResult.data;
        updateError = retryResult.error;
      }
      if (updateError && isMissingCardIssuanceColumnError(updateError) && "max_issuance_count" in updateData) {
        delete updateData.max_issuance_count;
        const retryResult = await supabaseAdmin
          .from("cards")
          .update(updateData)
          .eq("id", id)
          .select()
          .maybeSingle();
        updatedCardData = retryResult.data;
        updateError = retryResult.error;
      }

      // Issue #393: deploy-window safety — retry without collection_name if the
      // column is not migrated yet so other field edits still persist. Mirrors the
      // card_number retry above.
      if (updateError && isMissingCollectionNameColumn(updateError) && "collection_name" in updateData) {
        delete updateData.collection_name;
        const retryResult = await supabaseAdmin
          .from("cards")
          .update(updateData)
          .eq("id", id)
          .select()
          .maybeSingle();
        updatedCardData = retryResult.data;
        updateError = retryResult.error;
      }
      updatedCard = updatedCardData;
      error = updateError;
    }

    if (error) {
      if (isCardNumberConflictError(error)) {
        return NextResponse.json(
          { error: CARD_NUMBER_MESSAGES.duplicate },
          { status: 409 }
        );
      }
      return handleDatabaseError(error, "Failed to update card");
    }

    // 再計算はベストエフォート: カード更新は成功しているため、
    // 再計算失敗でも500を返さない。次回のカード操作で再計算が走り自己修復する。
    let recalculatedCards = null;
    if (shouldRecalculate) {
      try {
        recalculatedCards = await recalculateIfAutoMode(
          supabaseAdmin,
          card.streamer_id,
          rarityWeights
        );
      } catch (recalculationError) {
        logger.error("Cards API: Recalculation failed after card update", recalculationError);
      }
    }

    return NextResponse.json({
      ...updatedCard,
      recalculatedCards,
      ...(collectionNameSkippedDeployWindow ? { collectionNameSkippedDeployWindow: true } : {}),
    });
  } catch (error) {
    return handleApiError(error, "Cards API: PUT");
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

  const { id } = await params;

  try {
    // #663: cards への DELETE(書き込み)を含むハンドラのため、以降の全 DB
    // アクセスを usePgWrite で分岐する(ファイル冒頭のコメント参照)。判定は
    // ここで 1 回だけ行って固定し、リクエスト処理の途中で環境変数が変わっても
    // 経路が混在しないようにする(battle/start route と同じ設計)。
    const usePgWrite = isPgWriteEnabled();

    const supabaseAdmin = getSupabaseAdmin();

    // Get card with image_url for deletion
    // 削除用にimage_url付きでカードを取得
    const { data: card } = usePgWrite
      ? { data: await fetchCardForDeletePg(id) }
      : await supabaseAdmin
          .from("cards")
          // streamers の埋め込みは FK 制約名で一意化する(PUT と同じ理由: migration
          // 00051 の card_owner_stats が cards↔streamers を m2m にも見せ、ヒント
          // なしの streamers(...) は PGRST201 で失敗するため)。
          .select("streamer_id, image_url, streamers!cards_streamer_id_fkey!inner(twitch_user_id, rarity_weights)")
          .eq("id", id)
          .maybeSingle();

    const twitchUserId = extractTwitchUserId(card?.streamers);

    if (!card || twitchUserId === null || twitchUserId !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // Delete image from storage if it exists (R2 or Vercel Blob)
    // ストレージから画像を削除（存在する場合、R2またはVercel Blob）
    if (card.image_url && isStorageUrl(card.image_url)) {
      try {
        // DBからファイル情報を削除し、使用量を減算
        await removeBlobFile(card.image_url);
      } catch (dbError) {
        // DB操作に失敗しても続行
        logger.warn(`Failed to remove blob file from DB: ${card.image_url}`, dbError);
      }

      try {
        if (isR2Url(card.image_url)) {
          // R2から削除
          const key = getR2KeyFromUrl(card.image_url);
          if (key) {
            await deleteFromR2(key);
            logger.info(`Deleted R2 image: ${card.image_url}`);
          }
        } else if (isVercelBlobUrl(card.image_url)) {
          // Vercel Blob URLs are no longer actively deleted
          // Migration to R2 should have moved these files
          // Vercel Blob URLは削除しない（R2移行済みのはず）
          logger.warn(`Vercel Blob URL found but deletion skipped: ${card.image_url}`);
        }
      } catch (storageError) {
        // Log but don't fail the card deletion if storage deletion fails
        // ストレージ削除が失敗してもカード削除は続行（ログのみ記録）
        logger.warn(`Failed to delete storage image: ${card.image_url}`, storageError);
      }
    }

    const { error } = usePgWrite
      ? await deleteCardPg(id)
      : await supabaseAdmin
          .from("cards")
          .delete()
          .eq("id", id);

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
          supabaseAdmin,
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
