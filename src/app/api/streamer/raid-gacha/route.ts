import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { logger } from "@/lib/logger";
// -----------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。
// - getOwnedStreamer は読み取り専用のため isPgReadEnabled() で分岐する。
// - POST の UPDATE（raid_gacha_draw_count）は書き込みのため isPgWriteEnabled() で
//   分岐する。
// 既存 supabase-js 実装は 1 文字も変えず、フラグ未設定時は完全に従来どおり動く。
// pg 実装は getDb() を withDbRetry の queryFn 内で呼ぶ規約（src/lib/db/retry.ts 参照）。
// -----------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled, isPgWriteEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { streamers as streamersTable } from "@/lib/db/schema";

type GenericDbError = { message?: string; code?: string } | null | undefined;

function isRaidStateSchemaError(error: GenericDbError) {
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

interface OwnedStreamerRaidState {
  id: string;
  raid_gacha_active_until: string | null;
  raid_gacha_draw_count: number;
}

interface GetOwnedStreamerResult {
  streamer: OwnedStreamerRaidState | null;
  error: unknown;
}

/**
 * getOwnedStreamer の pg 直結実装 (#663)
 *
 * PostgREST 実装との対応:
 * - streamers を twitch_user_id で 1 行取得。twitch_user_id は UNIQUE
 *   （migration 00001）のため LIMIT 1 + rows[0] ?? null で .maybeSingle() と
 *   同じ外部挙動。
 * - isRaidStateSchemaError は既存の汎用テキスト判定（code === "PGRST204" || 列名を
 *   含む message）をそのまま再利用する。pg（postgres.js）の 42703 は code こそ
 *   異なるが、message に列名がそのまま含まれるため message.includes(...) 側で
 *   同じ条件式のまま判定できる（新規の pg 専用エラー整形ヘルパーは作らない）。
 * - 呼び出し元（GET/POST）は `{ streamer, error }` の形状に依存しているため、
 *   pg 版もスローされた例外をこの形状へ変換して返す。
 */
async function getOwnedStreamerPg(twitchUserId: string): Promise<GetOwnedStreamerResult> {
  const selectFull = () =>
    withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
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
      "getOwnedStreamer(raid gacha)",
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true },
    );

  const selectFallback = () =>
    withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "getOwnedStreamer(raid gacha fallback)",
      { idempotent: true },
    );

  try {
    const rows = await selectFull();
    return { streamer: rows[0] ?? null, error: null };
  } catch (error) {
    if (isRaidStateSchemaError(error as GenericDbError)) {
      try {
        const rows = await selectFallback();
        const row = rows[0] ?? null;
        return {
          streamer: row ? { ...row, raid_gacha_active_until: null, raid_gacha_draw_count: 0 } : null,
          error: null,
        };
      } catch (fallbackError) {
        return { streamer: null, error: fallbackError };
      }
    }
    return { streamer: null, error };
  }
}

async function getOwnedStreamer(twitchUserId: string): Promise<GetOwnedStreamerResult> {
  // #663: 読み取り専用の関数のため isPgReadEnabled() で分岐。
  // フラグ未設定時（既定 'postgrest'）は素通りし、以下の既存実装が従来どおり動く。
  if (isPgReadEnabled()) {
    return getOwnedStreamerPg(twitchUserId);
  }

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

interface UpdateRaidGachaDrawCountResult {
  data: { raid_gacha_active_until: string | null; raid_gacha_draw_count: number } | null;
  error: unknown;
}

/**
 * updateRaidGachaDrawCount の pg 直結実装 (#663)
 *
 * UPDATE は毎回同じ明示値（リクエストで検証済みの drawCount）を書く全置換の
 * ため、リトライしても最終状態は変わらない = 冪等（idempotent: true）。
 */
async function updateRaidGachaDrawCountPg(
  streamerId: string,
  drawCount: number
): Promise<UpdateRaidGachaDrawCountResult> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .update(streamersTable)
          .set({ raid_gacha_draw_count: drawCount })
          .where(eq(streamersTable.id, streamerId))
          .returning({
            raid_gacha_active_until: streamersTable.raid_gacha_active_until,
            raid_gacha_draw_count: streamersTable.raid_gacha_draw_count,
          });
      },
      "updateRaidGachaDrawCount",
      { idempotent: true },
    );
    return { data: rows[0] ?? null, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

async function updateRaidGachaDrawCount(
  streamerId: string,
  drawCount: number
): Promise<UpdateRaidGachaDrawCountResult> {
  // #663: 書き込みのみの関数のため isPgWriteEnabled() で分岐。
  if (isPgWriteEnabled()) {
    return updateRaidGachaDrawCountPg(streamerId, drawCount);
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("streamers")
    .update({ raid_gacha_draw_count: drawCount })
    .eq("id", streamerId)
    .select("raid_gacha_active_until, raid_gacha_draw_count")
    .maybeSingle();

  return { data, error };
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
    const { streamer, error } = await getOwnedStreamer(session.twitchUserId);
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
    const body = await request.json();
    const requestedDrawCount = body.drawCount === undefined ? 0 : Number(body.drawCount);

    // Issue #641: upper bound raised from 10 to 15 (fixed limit, confirmed by owner).
    if (!Number.isInteger(requestedDrawCount) || requestedDrawCount < 0 || requestedDrawCount > 15) {
      return NextResponse.json(
        { error: "drawCount must be an integer between 0 and 15" },
        { status: 400 },
      );
    }

    const { streamer, error: streamerError } = await getOwnedStreamer(session.twitchUserId);
    if (streamerError) return handleDatabaseError(streamerError, "Raid Gacha API: POST lookup");
    if (!streamer) return NextResponse.json({ error: ERROR_MESSAGES.STREAMER_NOT_FOUND }, { status: 404 });

    const { data: updatedStreamer, error } = await updateRaidGachaDrawCount(streamer.id, requestedDrawCount);

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
