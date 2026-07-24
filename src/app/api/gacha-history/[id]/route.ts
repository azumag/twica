import { type NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() / isPgWriteEnabled() が false を返すため getDb() は一切
// 呼ばれず、既存の supabase-js 経路が従来どおり実行される。
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { gachaHistory as gachaHistoryTable } from "@/lib/db/schema";

interface DeleteRequestBody {
  userId: string;
}

interface GachaHistoryDriverError {
  message: string;
}

/**
 * gacha_history 所有者確認の pg 直結実装 (#663)
 * PostgREST 実装との対応: .maybeSingle() は id が PK のため最大 1 行、
 * LIMIT 1 + rows[0] ?? null で同じ外部挙動。
 */
async function fetchGachaHistoryOwnerPg(
  id: string
): Promise<{ data: { user_twitch_id: string | null } | null; error: GachaHistoryDriverError | null }> {
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
      "gacha-history/[id](fetch owner)",
      { idempotent: true },
    );
    return { data: rows[0] ?? null, error: null };
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * gacha_history の DELETE の pg 直結実装 (#663)
 *
 * PK（id）指定の DELETE は再実行しても最終状態（対象行が存在しない）が同じ
 * ため冪等（storage-db.ts removeBlobFilePg と同じ判断）。接続断リトライを許可する。
 */
async function deleteGachaHistoryPg(id: string): Promise<{ error: GachaHistoryDriverError | null }> {
  try {
    await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db.delete(gachaHistoryTable).where(eq(gachaHistoryTable.id, id));
      },
      "gacha-history/[id](delete)",
      { idempotent: true },
    );
    return { error: null };
  } catch (error) {
    return {
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  }
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

    // Verify the gacha history belongs to the user
    // #663: 読み取り専用のため isPgReadEnabled() で分岐。
    const { data: history, error: fetchError } = await fetchGachaHistoryOwnerPg(id);

    if (fetchError || !history) {
      return handleDatabaseError(fetchError, "Fetching gacha history for deletion");
    }

    if (history.user_twitch_id !== session.twitchUserId) {
      return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
    }

    // #663: 書き込みのため isPgWriteEnabled() で分岐。
    const { error } = await deleteGachaHistoryPg(id);

    if (error) {
      return handleDatabaseError(error, "Deleting gacha history");
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleApiError(error, "Deleting gacha history");
  }
}
