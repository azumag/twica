import { type NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";

import { handleApiError } from "@/lib/error-handler";
import {
  checkRateLimit,
  rateLimits,
  getRateLimitIdentifier,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import {
  getGachaHistoryForStreamer,
  getGachaHistoryForUser,
  getGachaUsersForStreamer,
} from "@/lib/dashboard-data";
// ---------------------------------------------------------------------------
// （getGachaHistoryForStreamer 等）は #571 で既に pg 直結対応済みのため、この
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

import { withDbRetry } from "@/lib/db/retry";
import { streamers as streamersTable } from "@/lib/db/schema";

/**
 * streamer 取得の pg 直結実装 (#663)
 * （migration 00001）により最大 1 行のため LIMIT 1 + rows[0] ?? null で同じ
 * 外部挙動。既存コードは error を確認しない（data のみ利用）ため、pg 版も
 * 取得失敗時は null（=配信者なし=404 扱い）に揃える。
 */
async function fetchStreamerIdPg(twitchUserId: string): Promise<{ id: string } | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ id: streamersTable.id })
          .from(streamersTable)
          .where(eq(streamersTable.twitch_user_id, twitchUserId))
          .limit(1);
      },
      "gacha-history(streamer)",
      { idempotent: true },
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

const VALID_RARITIES = ["common", "rare", "epic", "legendary"];
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse integer with NaN fallback
 * NaN時にデフォルト値を返すintパーサー
 */
function safeParseInt(value: string | null, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * GET /api/gacha-history
 * Gacha history endpoint with role-based access:
 * - Streamer: view all gacha history for their channel (with filters)
 * - Viewer: view only their own gacha history
 *
 * ガチャ履歴エンドポイント（ロールベースアクセス）:
 * - 配信者: 自チャネルの全ガチャ履歴（フィルタ付き）
 * - 視聴者: 自分のガチャ履歴のみ
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.UNAUTHORIZED },
        { status: 401 }
      );
    }

    const identifier = await getRateLimitIdentifier(
      request,
      session.twitchUserId
    );
    const rateLimitResult = await checkRateLimit(
      rateLimits.gachaHistoryGet,
      identifier
    );

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

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, safeParseInt(searchParams.get("page"), 1));
    const perPage = Math.min(
      100,
      Math.max(1, safeParseInt(searchParams.get("perPage"), 20))
    );

    const isStreamer = canUseStreamerFeatures(session);
    // Allow streamers to view their own personal history with view=personal
    // 配信者が view=personal で自分の履歴を閲覧可能にする
    const view = searchParams.get("view");

    if (isStreamer && view !== "personal") {
      // Streamer: get their streamer_id
      // 配信者: streamer_idを取得
      // #663: 読み取り専用のため PlanetScale の単一接続を使用。
      const streamer = await fetchStreamerIdPg(session.twitchUserId);

      if (!streamer) {
        return NextResponse.json(
          { error: ERROR_MESSAGES.STREAMER_NOT_FOUND },
          { status: 404 }
        );
      }

      // Users view: return aggregated user list
      // ユーザービュー: 集約されたユーザー一覧を返す
      if (view === "users") {
        const result = await getGachaUsersForStreamer(streamer.id, { page, perPage });
        return NextResponse.json(result);
      }

      // Channel history view with filters
      // チャネル履歴ビュー（フィルタ付き）
      const username = searchParams.get("username")?.slice(0, 100) || undefined;

      // Validate rarity against whitelist, ignore invalid values
      // レアリティをホワイトリストで検証、不正な値は無視
      const rawRarity = searchParams.get("rarity");
      const rarity =
        rawRarity && VALID_RARITIES.includes(rawRarity)
          ? rawRarity
          : undefined;

      // Validate cardId (UUID format), ignore invalid values
      // cardIdのバリデーション（UUID形式）、不正な値は無視
      const rawCardId = searchParams.get("cardId");
      const cardId = rawCardId && UUID_REGEX.test(rawCardId) ? rawCardId : undefined;

      // Validate userId format / userIdフォーマットのバリデーション
      const rawUserId = searchParams.get("userId");
      const userId = rawUserId && /^\d+$/.test(rawUserId) ? rawUserId : undefined;

      // Validate date format (YYYY-MM-DD), ignore invalid values
      // 日付フォーマットの検証（YYYY-MM-DD）、不正な値は無視
      const rawFrom = searchParams.get("from");
      const from = rawFrom && DATE_REGEX.test(rawFrom) ? rawFrom : undefined;
      const rawTo = searchParams.get("to");
      const to = rawTo && DATE_REGEX.test(rawTo) ? rawTo : undefined;

      const result = await getGachaHistoryForStreamer(streamer.id, {
        page,
        perPage,
        username,
        rarity,
        cardId,
        userId,
        from,
        to,
      });

      return NextResponse.json(result);
    } else {
      // Viewer: fetch only their own history
      // 視聴者: 自分の履歴のみ取得
      const result = await getGachaHistoryForUser(session.twitchUserId, {
        page,
        perPage,
      });

      return NextResponse.json(result);
    }
  } catch (error) {
    return handleApiError(error, "Fetching gacha history");
  }
}
