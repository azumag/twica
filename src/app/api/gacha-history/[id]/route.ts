import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
// #663: 所有者チェック(SELECT) + DELETE の読み書き混在のため、関数全体を
// isPgWriteEnabled() で分岐する（src/lib/twitch/sub-check.ts の hasTwitchSubPg
// と同じ方針）。getDb() は withDbRetry の queryFn 内で呼ぶ規約（retry.ts 参照）。
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgWriteEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { gachaHistory as gachaHistoryTable } from "@/lib/db/schema";

interface DeleteRequestBody {
  userId: string;
}

/**
 * DELETE /api/gacha-history/[id] の pg 直結実装 (#663)
 *
 * 所有者チェックの SELECT と本体の DELETE が混在する関数のため、関数全体を
 * isPgWriteEnabled() で分岐する。
 *
 * PostgREST 実装との対応:
 * - 所有者チェック SELECT: .maybeSingle() は id が gacha_history の PRIMARY KEY
 *   のため LIMIT 1 + rows[0] ?? null が同じ外部挙動。
 * - 取得失敗 or 0 行（対象が存在しない）: 既存実装は
 *   `if (fetchError || !history) return handleDatabaseError(fetchError, ...)`
 *   のとおり、0 行のケース（fetchError は null）でも 404 ではなく
 *   handleDatabaseError（500 "Database error"）を返す。つまり「削除対象が
 *   既に無い」場合は no-op ではなく明示的なエラー応答という既存の非冪等な
 *   外部挙動であり、pg 経路もこれをそのまま再現する（同一 id への DELETE
 *   連投は 2 回目以降 500 になるのが既存仕様）。
 * - 所有者不一致は既存と同じ 403 FORBIDDEN。
 * - DELETE 本体は既定（idempotent 指定なし = リトライなし）のままとする。
 *   retry.ts の opt-in 対象は「読み取り／同値を書く UPDATE／ON CONFLICT DO
 *   NOTHING の INSERT」の3種のみで、単純な DELETE はこれに含まれない
 *   （冪等キーを持たない一般的な DELETE は既定＝リトライなしが安全、という
 *   本タスクの方針どおり）。接続断はクエリがサーバーに届いたか不明な状態で
 *   あり、盲目的なリトライは避ける。
 */
async function deleteGachaHistoryPg(id: string, twitchUserId: string): Promise<NextResponse> {
  let history: { user_twitch_id: string } | null;
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ user_twitch_id: gachaHistoryTable.user_twitch_id })
          .from(gachaHistoryTable)
          .where(eq(gachaHistoryTable.id, id))
          .limit(1);
      },
      "gacha-history:delete(fetch)",
      // 読み取り専用クエリのため冪等（リトライ可）
      { idempotent: true }
    );
    history = rows[0] ?? null;
  } catch (fetchError) {
    return handleDatabaseError(fetchError, "Fetching gacha history for deletion");
  }

  if (!history) {
    // 既存実装は 0 行時も handleDatabaseError(undefined, ...) を呼ぶ（404 では
    // なく 500）。pg 経路も同じ外部挙動に合わせる。
    return handleDatabaseError(null, "Fetching gacha history for deletion");
  }

  if (history.user_twitch_id !== twitchUserId) {
    return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
  }

  try {
    await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db.delete(gachaHistoryTable).where(eq(gachaHistoryTable.id, id));
      },
      "gacha-history:delete"
      // idempotent 指定なし（既定=リトライなし）。判断根拠は関数doc参照。
    );
  } catch (deleteError) {
    return handleDatabaseError(deleteError, "Deleting gacha history");
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
    }

    const identifier = await getRateLimitIdentifier(request, session.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.gachaHistoryDelete, identifier);

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

    const { id } = await params;
    const body = await request.json() as DeleteRequestBody;
    const { userId } = body;

    if (!userId) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }

    // #663: 所有者チェック(SELECT) + DELETE の読み書き混在のため関数全体を
    // isPgWriteEnabled() で分岐。フラグ未設定時（既定 'postgrest'）は以下の
    // 既存 supabase-js 実装が従来どおり動く。
    if (isPgWriteEnabled()) {
      return deleteGachaHistoryPg(id, session.twitchUserId);
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Verify the gacha history belongs to the user
    const { data: history, error: fetchError } = await supabaseAdmin
      .from("gacha_history")
      .select("user_twitch_id")
      .eq("id", id)
      .maybeSingle();

    if (fetchError || !history) {
      return handleDatabaseError(fetchError, "Fetching gacha history for deletion");
    }

    if (history.user_twitch_id !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    const { error } = await supabaseAdmin
      .from("gacha_history")
      .delete()
      .eq("id", id);

    if (error) {
      return handleDatabaseError(error, "Deleting gacha history");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Deleting gacha history");
  }
}