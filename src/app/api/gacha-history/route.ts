import { NextRequest, NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
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
      const supabaseAdmin = getSupabaseAdmin();
      const { data: streamer } = await supabaseAdmin
        .from("streamers")
        .select("id")
        .eq("twitch_user_id", session.twitchUserId)
        .maybeSingle();

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
