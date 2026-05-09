import { NextRequest, NextResponse } from "next/server";
import { validateCSRFToken } from "@/lib/csrf";
import { getSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { checkRateLimit, getRateLimitIdentifier, rateLimits } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";

type ExchangeDuplicateCardResult = {
  cardId: string;
  stonesGained: number;
  balance: number;
  remainingCount: number;
};

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function mapExchangeError(message: string): { status: number; error: string } | null {
  if (message.includes("NO_DUPLICATE_CARD")) {
    return { status: 409, error: "このカードには砕けるダブりがありません" };
  }
  if (message.includes("CARD_NOT_FOUND")) {
    return { status: 404, error: "カードが見つかりません" };
  }
  if (message.includes("USER_NOT_FOUND")) {
    return { status: 404, error: "ユーザーが見つかりません" };
  }
  return null;
}

export async function POST(request: NextRequest) {
  const csrfValidation = await validateCSRFToken(request);
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: csrfValidation.error || ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    );
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.UNAUTHORIZED },
      { status: 401 }
    );
  }

  const identifier = await getRateLimitIdentifier(request, session.twitchUserId);
  const rateLimit = await checkRateLimit(rateLimits.cardsPost, identifier);
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
      { status: 429 }
    );
  }

  try {
    const body = await request.json().catch(() => null) as { cardId?: unknown } | null;
    if (!isUuid(body?.cardId)) {
      return NextResponse.json(
        { error: "cardId is required" },
        { status: 400 }
      );
    }

    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await supabaseAdmin.rpc("exchange_duplicate_card_for_stones", {
      p_twitch_user_id: session.twitchUserId,
      p_card_id: body.cardId,
    });

    if (error) {
      const mapped = mapExchangeError(error.message || "");
      if (mapped) {
        return NextResponse.json({ error: mapped.error }, { status: mapped.status });
      }
      return handleApiError(error, "Card Stones Exchange API");
    }

    return NextResponse.json(data as ExchangeDuplicateCardResult);
  } catch (error) {
    return handleApiError(error, "Card Stones Exchange API");
  }
}
