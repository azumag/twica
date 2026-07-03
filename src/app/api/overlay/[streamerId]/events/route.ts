import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { withRetry } from "@/lib/supabase/retry";
import { handleApiError, handleDatabaseError } from "@/lib/error-handler";
import {
  checkRateLimit,
  getRateLimitIdentifier,
  rateLimits,
} from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import type { Rarity } from "@/types/database";
import type { ApiRateLimitResponse } from "@/types/api";

interface RouteParams {
  params: Promise<{ streamerId: string }>;
}

interface OverlayHistoryCard {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  rarity: Rarity;
}

interface OverlayHistoryRow {
  id: string;
  event_id: string | null;
  redeemed_at: string;
  user_twitch_username: string | null;
  // Issue #591: migration 00070 で追加。デプロイ窓では未選択(下のフォールバック
  // クエリ)になりうるため undefined も許容する。
  reward_id?: string | null;
  cards: OverlayHistoryCard | OverlayHistoryCard[] | null;
}

/**
 * Issue #591: gacha_history.reward_id (migration 00070) が未デプロイのDBに
 * ローリングデプロイ中の新アプリコードが SELECT すると発生する読み取りエラーを
 * 検知する。書き込み経路の PGRST204 とは異なり、SELECT/ORDER/フィルタでの
 * 列欠落は PostgreSQL が直接 42703 ("column ... does not exist") を返す
 * (このモジュールでは書き込みは発生しないため 42703 が主だが、PostgREST の
 * スキーマキャッシュ経由のPGRST204も念のため許容する)。
 * collection-existence.ts の isMissingCollectionNameColumn 等と同じ判定パターン。
 */
function isMissingRewardIdColumnError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined
): boolean {
  if (!error) return false;
  const text = [error.message, error.details, error.hint]
    .map((value) => String(value ?? ""))
    .join(" ");

  return (
    text.includes("reward_id") &&
    (error.code === "PGRST204" ||
      text.includes("does not exist") ||
      text.includes("schema cache"))
  );
}

const OVERLAY_HISTORY_SELECT_WITH_REWARD_ID =
  "id, event_id, redeemed_at, user_twitch_username, reward_id, cards(id, name, description, image_url, rarity)";
const OVERLAY_HISTORY_SELECT_WITHOUT_REWARD_ID =
  "id, event_id, redeemed_at, user_twitch_username, cards(id, name, description, image_url, rarity)";

function normalizeDateParam(value: string | null): string | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }

  // Cloudflare/OBS combinations can send Postgres timestamps with
  // microseconds (6 fractional digits), which some runtimes reject.
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) return null;

  const [, base, fraction = "", timezone] = match;
  const normalizedFraction = fraction.padEnd(3, "0").slice(0, 3);
  const normalized = `${base}.${normalizedFraction}${timezone}`;
  const normalizedTimestamp = Date.parse(normalized);
  return Number.isFinite(normalizedTimestamp)
    ? new Date(normalizedTimestamp).toISOString()
    : null;
}

function resolveCard(cards: OverlayHistoryRow["cards"]): OverlayHistoryCard | null {
  if (Array.isArray(cards)) {
    return cards[0] ?? null;
  }
  return cards;
}

/**
 * GET /api/overlay/[streamerId]/events
 *
 * Public polling fallback for OBS overlays. Realtime remains the primary path,
 * but this endpoint lets overlays recover when Supabase Realtime rejects public
 * channel joins or a browser source loses its WebSocket for a long period.
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { streamerId } = await params;
    if (!streamerId) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_ID_REQUIRED },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const since = normalizeDateParam(searchParams.get("since"));
    if (!since) {
      return NextResponse.json(
        { error: "Invalid since parameter" },
        { status: 400 }
      );
    }

    const identifier = await getRateLimitIdentifier(request);
    const rateLimitResult = await checkRateLimit(
      rateLimits.overlayEventsGet,
      identifier
    );

    if (!rateLimitResult.success) {
      return NextResponse.json<ApiRateLimitResponse>(
        {
          error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
          retryAfter:
            (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
        },
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

    const supabaseAdmin = getSupabaseAdmin();
    let { data, error } = await withRetry(
      () =>
        supabaseAdmin
          .from("gacha_history")
          .select(OVERLAY_HISTORY_SELECT_WITH_REWARD_ID)
          .eq("streamer_id", streamerId)
          .gt("redeemed_at", since)
          .order("redeemed_at", { ascending: true })
          .limit(10),
      "overlayEvents",
      { maxRetries: 1 }
    );

    // Issue #591 デプロイ窓フォールバック: gacha_history.reward_id (migration 00070)
    // がまだ本番DBに適用されていない状態で新アプリコードがSELECTすると読み取り
    // エラーになる。列を含めない従来のクエリへ1回だけ再試行し、rewardId は
    // null(=既存の rarity/all ルールへのフォールバック挙動)として扱う。
    // isMissingCollectionNameColumn 等(collection-existence.ts)と同じ
    // 「列剥がして再試行」パターン。
    if (error && isMissingRewardIdColumnError(error)) {
      const fallback = await withRetry(
        () =>
          supabaseAdmin
            .from("gacha_history")
            .select(OVERLAY_HISTORY_SELECT_WITHOUT_REWARD_ID)
            .eq("streamer_id", streamerId)
            .gt("redeemed_at", since)
            .order("redeemed_at", { ascending: true })
            .limit(10),
        "overlayEvents:reward-id-fallback",
        { maxRetries: 1 }
      );
      // supabase-js は select() の*リテラル*文字列からRow型を推論するため、列数が
      // 異なる2つのSELECTは互換性の無い別々の型になる(gacha.ts の
      // executeGacha 内 max_issuance_count フォールバックと同じ制約)。fallback行に
      // reward_id: null を明示的に補って、上のwith-reward-id型と構造的に一致させる。
      data = fallback.data?.map((row) => ({ ...row, reward_id: null })) ?? null;
      error = fallback.error;
    }

    if (error) {
      return handleDatabaseError(error, "Overlay Events API");
    }

    const events = ((data ?? []) as OverlayHistoryRow[])
      .map((row) => {
        const card = resolveCard(row.cards);
        if (!card) return null;
        return {
          id: row.id,
          eventId: row.event_id,
          redeemedAt: row.redeemed_at,
          userTwitchUsername: row.user_twitch_username ?? "Unknown",
          // Issue #591: ポーリング経路でも報酬別効果音ルールが評価できるよう、
          // gacha_history.reward_id をそのまま公開する。列未デプロイ時
          // (上のフォールバック後)は常に undefined ?? null = null になり、
          // 従来どおり rarity/all ルールへ安全にフォールバックする。
          rewardId: row.reward_id ?? null,
          card,
        };
      })
      .filter((event): event is NonNullable<typeof event> => event !== null);

    return NextResponse.json({ events });
  } catch (error) {
    return handleApiError(error, "Overlay Events API");
  }
}
