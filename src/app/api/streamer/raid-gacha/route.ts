import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { logger } from "@/lib/logger";
// ---------------------------------------------------------------------------
// #663 Batch C (#570 パイロット踏襲): pg 直結経路。GET は読み取り専用のため
// isPgReadEnabled() で分岐する(pg-read でも切替)。POST は streamers への
// UPDATE(書き込み)を含むため、所有権確認(streamers select)も含めた
// リクエスト内の全 DB アクセスを isPgWriteEnabled() で分岐する(読み書きで
// 経路が混ざると障害切り分けが困難になるため。cards/route.ts の POST・
// sub-check.ts 冒頭コメントと同じ判断)。フラグ未設定時(既定 'postgrest')は
// これらのモジュールの実行パスに一切入らないため、import が存在するだけでは
// 挙動に影響しない(tests/setup.ts の getDb throw スタブが「postgrest 経路で
// getDb が呼ばれない」ことを構造的に保証)。
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled, isPgWriteEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { streamers as streamersTable } from "@/lib/db/schema";

function isRaidStateSchemaError(error: { message?: string; code?: string } | null | undefined) {
  const message = error?.message ?? "";
  return error?.code === "PGRST204"
    || message.includes("raid_gacha_active_until")
    || message.includes("raid_gacha_draw_count");
}

function isActiveUntil(value: string | null | undefined): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function getOwnedStreamer(twitchUserId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  let { data: streamer, error } = await supabaseAdmin
    .from("streamers")
    .select("id, raid_gacha_active_until, raid_gacha_draw_count")
    .eq("twitch_user_id", twitchUserId)
    .maybeSingle();

  if (isRaidStateSchemaError(error)) {
    const fallbackResult = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", twitchUserId)
      .maybeSingle();
    streamer = fallbackResult.data
      ? { ...fallbackResult.data, raid_gacha_active_until: null, raid_gacha_draw_count: 0 }
      : fallbackResult.data;
    error = fallbackResult.error;
  }

  return { streamer, error };
}

/**
 * getOwnedStreamer の pg 直結実装 (#663 Batch C)。
 *
 * PostgREST 実装との対応:
 * - .eq("twitch_user_id", ...).maybeSingle() は twitch_user_id の UNIQUE 制約
 *   (migration 00001)により最大 1 行のため LIMIT 1 + rows[0] ?? null が同じ
 *   外部挙動。
 * - raid_gacha_active_until / raid_gacha_draw_count 列未デプロイ時のカスケード
 *   フォールバックは既存実装と同じ判定関数(isRaidStateSchemaError。message
 *   文字列一致で判定しており、postgres.js がネイティブに投げる 42703 の
 *   メッセージにも同じ列名 + "does not exist" が含まれるため両ドライバで
 *   機能する。insertCardPg の doc コメント参照)をそのまま再利用する。
 * - 既存実装は呼び出し元へ { streamer, error } を返し、GET/POST 双方が
 *   `if (error) return handleDatabaseError(...)` を経てから `if (!streamer)`
 *   の 404 判定を行う(additional-rewards route の !streamer のみ判定とは
 *   異なり、ここではエラー種別を区別する契約)。この関数も同じ契約を維持する
 *   ため、フォールバックが失敗した場合もエラーをそのまま返す(握り潰さない)。
 * 読み取り専用クエリのため冪等(idempotent: true)としてリトライを opt-in する。
 */
async function getOwnedStreamerPg(twitchUserId: string): Promise<{
  streamer: { id: string; raid_gacha_active_until: string | null; raid_gacha_draw_count: number } | null;
  error: unknown;
}> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ(src/lib/db/retry.ts 参照)
        const { db } = await getDb();
        return db
          .select({
            id: streamersTable.id,
            raid_gacha_active_until: streamersTable.raid_gacha_active_until,
            raid_gacha_draw_count: streamersTable.raid_gacha_draw_count,
          })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "Raid Gacha API: streamer ownership(pg)",
      { idempotent: true }
    );
    return { streamer: rows[0] ?? null, error: null };
  } catch (error) {
    if (!isRaidStateSchemaError(error as { message?: string; code?: string } | null | undefined)) {
      return { streamer: null, error };
    }
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
        "Raid Gacha API: streamer ownership fallback(raid state,pg)",
        { idempotent: true }
      );
      const row = rows[0] ?? null;
      return {
        streamer: row ? { ...row, raid_gacha_active_until: null, raid_gacha_draw_count: 0 } : null,
        error: null,
      };
    } catch (fallbackError) {
      return { streamer: null, error: fallbackError };
    }
  }
}

/**
 * POST の streamers.raid_gacha_draw_count UPDATE の pg 直結実装 (#663 Batch C)。
 *
 * PostgREST 実装との対応:
 * - .update({...}).eq("id", ...).select("raid_gacha_active_until,
 *   raid_gacha_draw_count").maybeSingle() は「更新行の指定列のみを返す」ため、
 *   Drizzle の .returning({ raid_gacha_active_until, raid_gacha_draw_count })
 *   + rows[0] ?? null が同じ外部挙動。
 *
 * 冪等性判断(リトライ可): requestedDrawCount は呼び出し元(POST ハンドラ)で
 * リクエストボディから一度だけ検証・計算される「値の直接代入」のみで構成され
 * (カウンタ加算や一度きりの状態遷移を含まない)、queryFn の外で事前計算済みの
 * 値を書く UPDATE である。1 回目が実際にはコミット済みで応答だけ接続断で
 * 失われた場合でも、同一引数での再実行は同じ行に同じ値を再代入するだけで
 * 収束先の状態は変わらない(streamers.updated_at の BEFORE UPDATE トリガー
 * (migration 00001)によるタイムスタンプのみ再実行ごとに前進するが、呼び出し元は
 * この値を検証しない)。cards/[id]/route.ts の updateCardPg と同じ判断のため
 * idempotent: true として接続断リトライを許可する。
 */
async function updateRaidGachaDrawCountPg(
  streamerId: string,
  requestedDrawCount: number
): Promise<{
  data: { raid_gacha_active_until: string | null; raid_gacha_draw_count: number } | null;
  error: unknown;
}> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .update(streamersTable)
          .set({ raid_gacha_draw_count: requestedDrawCount })
          .where(eq(streamersTable.id, streamerId))
          .returning({
            raid_gacha_active_until: streamersTable.raid_gacha_active_until,
            raid_gacha_draw_count: streamersTable.raid_gacha_draw_count,
          });
      },
      "Raid Gacha API: POST update(pg)",
      // 事前計算した同じ値を書く UPDATE のためリトライしても冪等(上記 doc コメント参照)
      { idempotent: true }
    );
    return { data: rows[0] ?? null, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

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
      },
    );
  }

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    // #663 Batch C: 読み取り専用ハンドラのため isPgReadEnabled() で分岐
    // (pg-read / pg の両モードで pg 経路)。フラグ未設定時は素通りし、
    // 既存 supabase-js 実装(getOwnedStreamer)が従来どおり実行される。
    const { streamer, error } = isPgReadEnabled()
      ? await getOwnedStreamerPg(session.twitchUserId)
      : await getOwnedStreamer(session.twitchUserId);
    if (error) return handleDatabaseError(error, "Raid Gacha API: GET");
    if (!streamer) return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });

    return NextResponse.json({
      active: isActiveUntil(streamer.raid_gacha_active_until),
      activeUntil: streamer.raid_gacha_active_until,
      drawCount: streamer.raid_gacha_draw_count ?? 0,
    }, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  } catch (error) {
    return handleApiError(error, "Raid Gacha API: GET");
  }
}

export async function POST(request: NextRequest) {
  const contentTypeValidation = validateContentType(request, "application/json");
  if (contentTypeValidation) return contentTypeValidation;

  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
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
      },
    );
  }

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    // #663 Batch C: streamers.raid_gacha_draw_count への UPDATE(書き込み)を
    // 含むハンドラのため、所有権確認(streamers select)も含めたリクエスト内の
    // 全 DB アクセスを usePgWrite で分岐する(読み書きで経路が混ざると障害
    // 切り分けが困難になるため。cards/route.ts の POST と同じ判断)。判定は
    // ここで 1 回だけ行って固定し、リクエスト処理の途中で環境変数が変わっても
    // 経路が混在しないようにする(battle/start route と同じ設計)。
    const usePgWrite = isPgWriteEnabled();

    const body = await request.json();
    const requestedDrawCount = body.drawCount === undefined ? 0 : Number(body.drawCount);

    if (!Number.isInteger(requestedDrawCount) || requestedDrawCount < 0 || requestedDrawCount > 10) {
      return NextResponse.json(
        { error: "drawCount must be an integer between 0 and 10" },
        { status: 400 },
      );
    }

    const { streamer, error: streamerError } = usePgWrite
      ? await getOwnedStreamerPg(session.twitchUserId)
      : await getOwnedStreamer(session.twitchUserId);
    if (streamerError) return handleDatabaseError(streamerError, "Raid Gacha API: POST lookup");
    if (!streamer) return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });

    // #663 Batch C: pg 経路(usePgWrite)では updateRaidGachaDrawCountPg に委譲
    // する。postgrest 経路は既存実装のまま(内側の変数名のみ updatedStreamer →
    // updatedStreamerData に変更。cards/[id]/route.ts の PUT と同じ構造上の
    // 都合であり、クエリロジックは無変更)。
    let updatedStreamer: { raid_gacha_active_until: string | null; raid_gacha_draw_count: number } | null;
    let error: unknown;

    if (usePgWrite) {
      const result = await updateRaidGachaDrawCountPg(streamer.id, requestedDrawCount);
      updatedStreamer = result.data;
      error = result.error;
    } else {
      const supabaseAdmin = getSupabaseAdmin();
      const { data: updatedStreamerData, error: updateError } = await supabaseAdmin
        .from("streamers")
        .update({ raid_gacha_draw_count: requestedDrawCount })
        .eq("id", streamer.id)
        .select("raid_gacha_active_until, raid_gacha_draw_count")
        .maybeSingle();
      updatedStreamer = updatedStreamerData;
      error = updateError;
    }

    if (error) return handleDatabaseError(error, "Raid Gacha API: POST update");

    logger.info("Raid gacha state updated", {
      streamerId: streamer.id,
      drawCount: requestedDrawCount,
    });

    return NextResponse.json({
      success: true,
      active: isActiveUntil(updatedStreamer?.raid_gacha_active_until),
      activeUntil: updatedStreamer?.raid_gacha_active_until ?? null,
      drawCount: updatedStreamer?.raid_gacha_draw_count ?? requestedDrawCount,
    });
  } catch (error) {
    return handleApiError(error, "Raid Gacha API: POST");
  }
}
