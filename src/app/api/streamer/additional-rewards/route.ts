import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { logger } from "@/lib/logger";
import { resolveCollectionNameField, isRegisteredOrUnchanged, DEFAULT_PACK_SENTINEL } from "@/lib/validation/collection-name";
import {
  checkCollectionHasActiveCards,
  isMissingCollectionNameColumn,
  isMissingCardPackNamesColumnError,
} from "@/lib/collections/collection-existence";
// ---------------------------------------------------------------------------
// #663 Batch C (#570 パイロット踏襲): pg 直結経路。GET は読み取り専用のため
// isPgReadEnabled() で分岐する(pg-read でも切替)。POST/DELETE はいずれも
// streamer_additional_gacha_rewards への書き込み(INSERT/DELETE)を含むため、
// 所有権確認(streamers select)も含めたリクエスト内の全 DB アクセスを
// isPgWriteEnabled() で分岐する(読み書きで経路が混ざると障害切り分けが困難に
// なるため。cards/route.ts の POST・sub-check.ts 冒頭コメントと同じ判断)。
// フラグ未設定時(既定 'postgrest')はこれらのモジュールの実行パスに一切入らない
// ため、import が存在するだけでは挙動に影響しない(tests/setup.ts の getDb throw
// スタブが「postgrest 経路で getDb が呼ばれない」ことを構造的に保証)。
// ---------------------------------------------------------------------------
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled, isPgWriteEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { isPgMissingColumnError } from "@/lib/db/errors";
import {
  streamers as streamersTable,
  streamerAdditionalGachaRewards as rewardsTable,
} from "@/lib/db/schema";

function isRaidOptionsSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204" || message.includes("draw_count") || message.includes("is_raid_limited");
}

const RAID_OPTIONS_SCHEMA_PENDING_MESSAGE =
  "追加の引き換えのN連ガチャ設定がまだDBに反映されていません。少し待ってから再度追加してください。";

/**
 * GET/DELETE 共通: streamer.id のみの所有権確認 select の pg 直結実装 (#663 Batch C)。
 *
 * PostgREST 実装との対応:
 * - .eq("twitch_user_id", ...).maybeSingle() は twitch_user_id の UNIQUE 制約
 *   (migration 00001)により最大 1 行のため、LIMIT 1 + rows[0] ?? null が同じ
 *   外部挙動。
 * - 既存実装(GET/DELETE 双方)はこの select のエラーを一切チェックしない
 *   (`const { data: streamer } = await ...` のみ分割代入し、error を握り潰して
 *   `!streamer` だけで 404 判定している)。この「エラー種別を問わず取得失敗は
 *   404」という既存の緩い契約を pg 版でも再現するため、取得失敗(列不足を含む
 *   あらゆる throw)は catch して null を返す(fetchCardForDeletePg と同じ設計)。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchOwnedStreamerIdPg(twitchUserId: string): Promise<{ id: string } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ(src/lib/db/retry.ts 参照)
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "Additional Rewards API: streamer ownership(pg)",
      { idempotent: true }
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

type AdditionalRewardRow = {
  id: string;
  reward_id: string;
  reward_name: string | null;
  draw_count: number;
  is_raid_limited: boolean;
  collection_name: string | null;
  created_at: string | null;
};

/**
 * GET のガチャ追加報酬一覧取得の pg 直結実装 (#663 Batch C)。
 *
 * PostgREST 実装との対応(元の GET ハンドラの3段カスケードを、同じ「エラーを
 * 都度上書きする逐次代入」ロジック・同じ順序で再現する。ネストではなく順に
 * 判定することで、「1段目のフォールバックがさらに2段目のエラー条件にも一致
 * する」ケース(collection_name も raid options 列も両方未デプロイ)でも既存
 * 実装と同じ結果になる):
 * 1. 全列(collection_name 込み) select
 * 2. isMissingCollectionNameColumn 一致時: collection_name を除いて再試行し、
 *    結果へ collection_name: null を補完(#393: collection_name 単独未デプロイを
 *    raid フォールバックより先に処理し、draw_count/is_raid_limited を保持する)
 * 3. (1 or 2 の結果の)エラーが isRaidOptionsSchemaError に一致する場合:
 *    id/reward_id/reward_name/created_at のみ select し、draw_count: 1,
 *    is_raid_limited: false, collection_name: null を補完
 * 4. それでも残るエラーは呼び出し元(GET ハンドラ)の
 *    `if (error) return handleDatabaseError(...)` へそのまま渡す。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchAdditionalRewardsPg(
  streamerId: string
): Promise<{ rewards: AdditionalRewardRow[] | null; error: unknown }> {
  const selectFull = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: rewardsTable.id,
            reward_id: rewardsTable.reward_id,
            reward_name: rewardsTable.reward_name,
            draw_count: rewardsTable.draw_count,
            is_raid_limited: rewardsTable.is_raid_limited,
            collection_name: rewardsTable.collection_name,
            created_at: rewardsTable.created_at,
          })
          .from(rewardsTable)
          .where(eq(rewardsTable.streamer_id, streamerId))
          .orderBy(asc(rewardsTable.created_at));
      },
      "Additional Rewards API: GET(pg)",
      { idempotent: true }
    );

  const selectWithoutCollectionName = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: rewardsTable.id,
            reward_id: rewardsTable.reward_id,
            reward_name: rewardsTable.reward_name,
            draw_count: rewardsTable.draw_count,
            is_raid_limited: rewardsTable.is_raid_limited,
            created_at: rewardsTable.created_at,
          })
          .from(rewardsTable)
          .where(eq(rewardsTable.streamer_id, streamerId))
          .orderBy(asc(rewardsTable.created_at));
      },
      "Additional Rewards API: GET fallback(collection_name,pg)",
      { idempotent: true }
    );

  const selectRaidOptionsMinimal = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({
            id: rewardsTable.id,
            reward_id: rewardsTable.reward_id,
            reward_name: rewardsTable.reward_name,
            created_at: rewardsTable.created_at,
          })
          .from(rewardsTable)
          .where(eq(rewardsTable.streamer_id, streamerId))
          .orderBy(asc(rewardsTable.created_at));
      },
      "Additional Rewards API: GET fallback(raid options,pg)",
      { idempotent: true }
    );

  let rewards: AdditionalRewardRow[] | null = null;
  let error: unknown = null;

  try {
    rewards = await selectFull();
  } catch (e) {
    error = e;
  }

  if (error && isMissingCollectionNameColumn(error as { message?: string; code?: string; hint?: string })) {
    try {
      const fallbackRows = await selectWithoutCollectionName();
      rewards = fallbackRows.map((row) => ({ ...row, collection_name: null }));
      error = null;
    } catch (e) {
      rewards = null;
      error = e;
    }
  }

  if (error && isRaidOptionsSchemaError(error as { message?: string; code?: string } | null | undefined)) {
    try {
      const minimalRows = await selectRaidOptionsMinimal();
      rewards = minimalRows.map((row) => ({
        ...row,
        draw_count: 1,
        is_raid_limited: false,
        collection_name: null,
      }));
      error = null;
    } catch (e) {
      rewards = null;
      error = e;
    }
  }

  return { rewards, error };
}

/**
 * POST の streamer 所有権確認 + card_pack_names(事前登録パック一覧)取得の
 * pg 直結実装 (#663 Batch C)。
 *
 * PostgREST 実装との対応:
 * - .eq("twitch_user_id", ...).maybeSingle() は twitch_user_id の UNIQUE 制約
 *   (migration 00001)により最大 1 行のため LIMIT 1 + rows[0] ?? null が同じ
 *   外部挙動。
 * - card_pack_names 列未デプロイ(42703)時は列を落として再試行し、
 *   cardPackNamesUnavailable=true を呼び出し元に伝える(cards/route.ts の
 *   fetchStreamerForCardCreatePg と同じ判断: isPgMissingColumnError(SQLSTATE
 *   42703)で直接判定する。この select が参照する列のうち id /
 *   channel_point_reward_id は初版(00001)から存在し、card_pack_names のみ
 *   後発(00062)のため、42703 が起きるとすれば card_pack_names 起因と考えて
 *   良い)。
 * - 列未デプロイ以外のエラーは既存実装と同じく区別せず streamer=null 扱いに
 *   する(既存実装が `!streamer` だけで 404 判定しているため)。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function fetchStreamerForRewardCreatePg(twitchUserId: string): Promise<{
  streamer: { id: string; channel_point_reward_id: string | null; card_pack_names: string[] } | null;
  cardPackNamesUnavailable: boolean;
}> {
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
      "Additional Rewards API: POST streamer ownership(pg)",
      { idempotent: true }
    );
    const row = rows[0] ?? null;
    return {
      streamer: row
        ? {
            id: row.id,
            channel_point_reward_id: row.channel_point_reward_id,
            card_pack_names: row.card_pack_names ?? [],
          }
        : null,
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
            .select({
              id: streamersTable.id,
              channel_point_reward_id: streamersTable.channel_point_reward_id,
            })
            .from(streamersTable)
            .where(eq(streamersTable.twitch_user_id, twitchUserId))
            .limit(1);
        },
        "Additional Rewards API: POST streamer ownership fallback(card_pack_names,pg)",
        { idempotent: true }
      );
      const row = rows[0] ?? null;
      return {
        streamer: row
          ? { id: row.id, channel_point_reward_id: row.channel_point_reward_id, card_pack_names: [] }
          : null,
        cardPackNamesUnavailable: true,
      };
    } catch {
      return { streamer: null, cardPackNamesUnavailable: true };
    }
  }
}

/**
 * POST の streamer_additional_gacha_rewards INSERT の pg 直結実装 (#663 Batch C)。
 *
 * PostgREST 実装との対応:
 * - .insert(insertPayload).select().maybeSingle() は「挿入行の全列を返す」
 *   ため、Drizzle の .returning()(引数なし=全列)+ rows[0] ?? null が同じ
 *   外部挙動。
 * - collection_name 列未デプロイ時のカスケードリトライは既存実装と同じ判定
 *   関数(isMissingCollectionNameColumn。message 文字列一致で判定しており、
 *   postgres.js がネイティブに投げる 42703 のメッセージにも同じ列名 +
 *   "does not exist" が含まれるため両ドライバで機能する。insertCardPg の
 *   doc コメント参照)をそのまま再利用し、既存と同じ1回だけの再試行を再現
 *   する。
 * - raid options 列(draw_count/is_raid_limited)未デプロイのエラーはここでは
 *   リトライせず、そのまま呼び出し元(POST ハンドラ)へ返す(既存実装もここでは
 *   リトライせず、後続の isRaidOptionsSchemaError 分岐で 503 を返すだけ)。
 *
 * 冪等性判断(リトライ不可の根拠 — 重要): この INSERT には UNIQUE(streamer_id,
 * reward_id)(migration 00008)が付与されているが、ON CONFLICT 句の無い単純な
 * 新規作成 INSERT である。接続断は「クエリがサーバーに到達しコミット済みか
 * 不明」を意味するため、自動リトライすると「実際には1回目で成功しているのに
 * リトライで 23505 に化けて 409(このチャネルポイント引き換えは既に追加され
 * ています)をユーザーに返してしまう」— 本来成功しているはずの操作が失敗に
 * 見える事故につながる。二重作成そのものは UNIQUE 制約が防ぐため実害は無いが、
 * 「見た目の失敗」を避けるため、insertCardPg / insertBattlePg と同じ判断で
 * 非冪等(withDbRetry 既定 = リトライなし)として扱う。
 */
async function insertAdditionalRewardPg(
  insertPayload: Record<string, unknown>
): Promise<{ data: Record<string, unknown> | null; error: unknown }> {
  const data = { ...insertPayload };
  let result: Record<string, unknown> | null = null;
  let lastError: unknown = null;

  const tryInsert = async (): Promise<void> => {
    try {
      const rows = await withDbRetry(
        async () => {
          const { db } = await getDb();
          return db.insert(rewardsTable).values(data as never).returning();
        },
        "Additional Rewards API: POST insert(pg)"
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

  if (
    lastError &&
    isMissingCollectionNameColumn(lastError as { message?: string; code?: string; hint?: string }) &&
    "collection_name" in data
  ) {
    delete data.collection_name;
    await tryInsert();
  }

  return { data: result, error: lastError };
}

/**
 * DELETE(?deleteAll=true) の全件削除の pg 直結実装 (#663 Batch C)。
 *
 * 冪等性判断(リトライ可): streamer_id に対する無条件 DELETE で、既存実装は
 * 削除対象行数を検証しない(count を握り潰して常に null を返す。下記
 * deletedCount の quirk コメント参照)。接続断後の再実行は「既に削除済みの
 * 行を再度削除しようとして 0 行 DELETE」になるだけで、エラーにも最終状態にも
 * ならない(deleteCardPg と同じロジック)。よって idempotent: true として
 * 接続断リトライを許可する。
 *
 * deletedCount の既知の quirk: 既存 PostgREST 実装は
 * `.delete().eq(...).select()` で count オプション({ count: "exact" })を
 * 一切指定していない。@supabase/postgrest-js の delete()/select() は
 * Prefer: count=exact ヘッダーを明示的に要求したときのみ件数を返すため、
 * 本実装が受け取る `count` は常に null になる(既存の潜在バグだが「既存実装は
 * 1文字も変更しない」方針上、修正せずそのまま踏襲する)。pg 版で実削除件数を
 * 正しく返すと同一入力に対して両経路のレスポンスが変わってしまう(パリティ
 * 違反)ため、呼び出し元(DELETE ハンドラ)は deletedCount を常に null で返す。
 * 実削除件数は本関数の戻り値(deletedRowCount、ログ用)でのみ観測できる。
 */
async function deleteAllAdditionalRewardsPg(
  streamerId: string
): Promise<{ error: unknown; deletedRowCount: number }> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .delete(rewardsTable)
          .where(eq(rewardsTable.streamer_id, streamerId))
          .returning({ id: rewardsTable.id });
      },
      "Additional Rewards API: DELETE ALL(pg)",
      { idempotent: true }
    );
    return { error: null, deletedRowCount: rows.length };
  } catch (error) {
    return { error, deletedRowCount: 0 };
  }
}

/**
 * DELETE(?rewardId=xxx) の単一削除の pg 直結実装 (#663 Batch C)。
 *
 * 冪等性判断(リトライ可): (streamer_id, reward_id) は UNIQUE 制約
 * (migration 00008)のため対象は最大1行。既存実装はこの WHERE 句だけで完結し、
 * 削除0行でもエラーにしない(.select() で結果行数を確認していない)。接続断後の
 * 再実行は「既に削除済みの行に対する 0 行 DELETE」になるだけで、エラーにも
 * 最終状態にもならない(deleteCardPg と同じロジック)。よって idempotent: true
 * として接続断リトライを許可する。
 */
async function deleteAdditionalRewardPg(
  streamerId: string,
  rewardId: string
): Promise<{ error: unknown }> {
  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .delete(rewardsTable)
          .where(and(eq(rewardsTable.streamer_id, streamerId), eq(rewardsTable.reward_id, rewardId)));
      },
      "Additional Rewards API: DELETE(pg)",
      { idempotent: true }
    );
    return { error: null };
  } catch (error) {
    return { error };
  }
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
    // #663 Batch C: 読み取り専用ハンドラのため isPgReadEnabled() で分岐
    // (pg-read / pg の両モードで pg 経路)。フラグ未設定時は素通りし、下の
    // 既存 supabase-js 実装が従来どおり実行される。
    if (isPgReadEnabled()) {
      const streamer = await fetchOwnedStreamerIdPg(session.twitchUserId);
      if (!streamer) {
        return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
      }

      const { rewards, error } = await fetchAdditionalRewardsPg(streamer.id);
      if (error) {
        return handleDatabaseError(error, "Additional Rewards API: GET");
      }

      // キャッシュを無効化して、削除後も常に最新のデータを返す
      // Disable caching to ensure fresh data is returned after deletions
      return NextResponse.json(rewards || [], {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    // Fetch all additional rewards for this streamer
    // このストリーマーの全ての追加報酬を取得
    let { data: rewards, error } = await supabaseAdmin
      .from("streamer_additional_gacha_rewards")
      .select("id, reward_id, reward_name, draw_count, is_raid_limited, collection_name, created_at")
      .eq("streamer_id", streamer.id)
      .order("created_at", { ascending: true });

    // Issue #393: handle "only collection_name column missing" BEFORE the raid
    // fallback. Both match PGRST204, but the raid fallback would wrongly reset
    // draw_count / is_raid_limited, losing N-draw config. So check this first and
    // fall back to "all cards" (collection_name: null) while keeping raid options.
    // collection_name 列のみ未デプロイのケースを raid fallback より先に処理する。
    if (error && isMissingCollectionNameColumn(error)) {
      const fallbackResult = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .select("id, reward_id, reward_name, draw_count, is_raid_limited, created_at")
        .eq("streamer_id", streamer.id)
        .order("created_at", { ascending: true });
      rewards = (fallbackResult.data || []).map((reward) => ({
        ...reward,
        collection_name: null,
      }));
      error = fallbackResult.error;
    }

    if (isRaidOptionsSchemaError(error)) {
      const fallbackResult = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .select("id, reward_id, reward_name, created_at")
        .eq("streamer_id", streamer.id)
        .order("created_at", { ascending: true });
      rewards = (fallbackResult.data || []).map((reward) => ({
        ...reward,
        draw_count: 1,
        is_raid_limited: false,
        collection_name: null,
      }));
      error = fallbackResult.error;
    }

    if (error) {
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
    // #663 Batch C: streamer_additional_gacha_rewards への INSERT(書き込み)を
    // 含むハンドラのため、所有権確認(streamers select)も含めたリクエスト内の
    // 全 DB アクセスを usePgWrite で分岐する(読み書きで経路が混ざると障害
    // 切り分けが困難になるため。cards/route.ts の POST と同じ判断)。判定は
    // ここで 1 回だけ行って固定し、リクエスト処理の途中で環境変数が変わっても
    // 経路が混在しないようにする(battle/start route と同じ設計)。
    const usePgWrite = isPgWriteEnabled();

    const supabaseAdmin = getSupabaseAdmin();
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

    const normalizedDrawCount = drawCount === undefined ? 1 : Number(drawCount);
    if (!Number.isInteger(normalizedDrawCount) || normalizedDrawCount < 1 || normalizedDrawCount > 10) {
      return NextResponse.json(
        { error: "drawCount must be an integer between 1 and 10" },
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
    //
    // #663 Batch C: pg 経路(usePgWrite)では fetchStreamerForRewardCreatePg に
    // 委譲する。postgrest 経路は既存実装のまま(内側の変数名のみ streamer →
    // streamerData に変更。if/else 分岐の外側で共有する streamer 変数との
    // シャドーイングを避けるための構造上の都合であり、クエリ・カスケード
    // リトライの条件分岐ロジックは無変更。cards/[id]/route.ts の PUT と同じ
    // 対応)。
    let streamer: { id: string; channel_point_reward_id: string | null; card_pack_names: string[] } | null;
    let cardPackNamesUnavailable = false;

    if (usePgWrite) {
      const result = await fetchStreamerForRewardCreatePg(session.twitchUserId);
      streamer = result.streamer;
      cardPackNamesUnavailable = result.cardPackNamesUnavailable;
    } else {
      let { data: streamerData, error: streamerSelectError } = await supabaseAdmin
        .from("streamers")
        .select("id, channel_point_reward_id, card_pack_names")
        .eq("twitch_user_id", session.twitchUserId)
        .maybeSingle();

      // Issue #393再設計: card_pack_names がデプロイ窓で未検出の場合、それだけ
      // 外して再試行する(所有権確認・メイン報酬確認は継続できるようにする)。
      if (streamerSelectError && isMissingCardPackNamesColumnError(streamerSelectError)) {
        const retryResult = await supabaseAdmin
          .from("streamers")
          .select("id, channel_point_reward_id")
          .eq("twitch_user_id", session.twitchUserId)
          .maybeSingle();
        streamerData = retryResult.data ? { ...retryResult.data, card_pack_names: [] as string[] } : null;
        streamerSelectError = retryResult.error;
        cardPackNamesUnavailable = true;
      }
      streamer = streamerData;
    }

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
        supabaseAdmin,
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

    // #663 Batch C: pg 経路(usePgWrite)では insertAdditionalRewardPg に委譲
    // する。postgrest 経路は既存実装のまま(内側の変数名のみ newReward →
    // newRewardData に変更。cards/[id]/route.ts の PUT と同じ構造上の都合で
    // あり、クエリ・カスケードリトライの条件分岐ロジックは無変更)。
    let newReward: Record<string, unknown> | null;
    let error: unknown;

    if (usePgWrite) {
      const result = await insertAdditionalRewardPg(insertPayload);
      newReward = result.data;
      error = result.error;
    } else {
      let { data: newRewardData, error: insertError } = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .insert(insertPayload)
        .select()
        .maybeSingle();

      // Issue #393: deploy-window safety. Strip collection_name and retry if the
      // column is not migrated yet. Must run BEFORE the raid-options check because
      // both match PGRST204; otherwise we would return a misleading 503.
      if (insertError && isMissingCollectionNameColumn(insertError) && "collection_name" in insertPayload) {
        delete insertPayload.collection_name;
        const retryResult = await supabaseAdmin
          .from("streamer_additional_gacha_rewards")
          .insert(insertPayload)
          .select()
          .maybeSingle();
        newRewardData = retryResult.data;
        insertError = retryResult.error;
      }
      newReward = newRewardData;
      error = insertError;
    }

    if (isRaidOptionsSchemaError(error as { message?: string; code?: string } | null | undefined)) {
      logger.warn("Additional reward options schema is not ready; refusing to create a 1-draw fallback reward", {
        rewardId,
        streamerId: streamer.id,
        requestedDrawCount: normalizedDrawCount,
        error: (error as { message?: string } | null | undefined)?.message,
      });
      return NextResponse.json(
        { error: RAID_OPTIONS_SCHEMA_PENDING_MESSAGE },
        { status: 503 }
      );
    }

    if (error) {
      // Handle unique constraint violation (reward already added)
      // 一意制約違反を処理（報酬は既に追加済み）
      // postgres.js の PostgresError も code に SQLSTATE を持つため、同じ比較が
      // 両ドライバで機能する(isCardNumberConflictError と同じ判断)。
      if ((error as { code?: string } | null | undefined)?.code === "23505") {
        return NextResponse.json(
          { error: "このチャネルポイント引き換えは既に追加されています" },
          { status: 409 }
        );
      }
      return handleDatabaseError(error, "Additional Rewards API: POST");
    }

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

/**
 * DELETE: 追加報酬を削除
 * Delete additional gacha reward(s)
 * - ?rewardId=xxx: Delete specific reward
 * - ?deleteAll=true: Delete all additional rewards for the streamer
 */
export async function DELETE(request: NextRequest) {
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
    // #663 Batch C: streamer_additional_gacha_rewards への DELETE(書き込み)を
    // 含むハンドラのため、所有権確認(streamers select)も含めたリクエスト内の
    // 全 DB アクセスを usePgWrite で分岐する(POST と同じ判断)。判定はここで
    // 1 回だけ行って固定する。
    const usePgWrite = isPgWriteEnabled();

    const supabaseAdmin = getSupabaseAdmin();
    const url = new URL(request.url);
    const rewardId = url.searchParams.get("rewardId");
    const deleteAll = url.searchParams.get("deleteAll") === "true";

    if (usePgWrite) {
      const streamer = await fetchOwnedStreamerIdPg(session.twitchUserId);

      if (!streamer) {
        return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
      }

      if (deleteAll) {
        // Delete all additional rewards for this streamer
        // このストリーマーの全ての追加報酬を削除
        const { error, deletedRowCount } = await deleteAllAdditionalRewardsPg(streamer.id);

        if (error) {
          return handleDatabaseError(error, "Additional Rewards API: DELETE ALL");
        }

        logger.info(
          `All additional rewards deleted: streamerId=${streamer.id}, count=${deletedRowCount}`
        );

        // deletedCount は既存実装(postgrest)の quirk により常に null
        // (deleteAllAdditionalRewardsPg の doc コメント参照。パリティ優先)。
        return NextResponse.json({ success: true, deletedCount: null });
      } else if (rewardId) {
        // Delete specific reward
        // 特定の報酬を削除
        const { error } = await deleteAdditionalRewardPg(streamer.id, rewardId);

        if (error) {
          return handleDatabaseError(error, "Additional Rewards API: DELETE");
        }

        logger.info(
          `Additional reward deleted: streamerId=${streamer.id}, rewardId=${rewardId}`
        );

        return NextResponse.json({ success: true });
      } else {
        return NextResponse.json(
          { error: "rewardId または deleteAll パラメータが必要です" },
          { status: 400 }
        );
      }
    }

    // Get streamer info to verify ownership
    // ストリーマー情報を取得して所有権を確認
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", session.twitchUserId)
      .maybeSingle();

    if (!streamer) {
      return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });
    }

    if (deleteAll) {
      // Delete all additional rewards for this streamer
      // このストリーマーの全ての追加報酬を削除
      const { error, count } = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .delete()
        .eq("streamer_id", streamer.id)
        .select();

      if (error) {
        return handleDatabaseError(error, "Additional Rewards API: DELETE ALL");
      }

      logger.info(
        `All additional rewards deleted: streamerId=${streamer.id}, count=${count}`
      );

      return NextResponse.json({ success: true, deletedCount: count });
    } else if (rewardId) {
      // Delete specific reward
      // 特定の報酬を削除
      const { error } = await supabaseAdmin
        .from("streamer_additional_gacha_rewards")
        .delete()
        .eq("streamer_id", streamer.id)
        .eq("reward_id", rewardId);

      if (error) {
        return handleDatabaseError(error, "Additional Rewards API: DELETE");
      }

      logger.info(
        `Additional reward deleted: streamerId=${streamer.id}, rewardId=${rewardId}`
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
