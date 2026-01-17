import { NextRequest, NextResponse } from "next/server";
import { GachaService } from "@/lib/services/gacha";
import { handleApiError } from "@/lib/error-handler";
import { getSession } from "@/lib/session";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { reportGachaError } from "@/lib/sentry/error-handler";
import { setUserContext, setRequestContext } from "@/lib/sentry/user-context";
import { GACHA_COST, ERROR_MESSAGES } from "@/lib/constants";
import type { GachaSuccessResponse, GachaErrorResponse, ApiRateLimitResponse } from "@/types/api";

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  setRequestContext(requestId, '/api/gacha')
  
  let session: { twitchUserId: string; twitchUsername: string; broadcasterType?: string } | null = null
  let body: Record<string, unknown> | null = null
  
  try {
    session = await getSession()
    
    if (session) {
      setUserContext({
        twitchUserId: session.twitchUserId,
        twitchUsername: session.twitchUsername,
        broadcasterType: session.broadcasterType,
      })
    }

    const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
    const rateLimitResult = await checkRateLimit(rateLimits.gacha, identifier);

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

    if (!session) {
      return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
    }

    body = await request.json();
    const { streamerId } = body as { streamerId?: string };

    if (!streamerId) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.STREAMER_ID_REQUIRED },
        { status: 400 }
      );
    }

    const gachaService = new GachaService();
    const result = await gachaService.executeGacha(streamerId, session.twitchUserId, session.twitchUsername);

    if (!result.success) {
      // Map GachaService errors to standardized error messages
      let errorMessage: string = ERROR_MESSAGES.INTERNAL_ERROR;
      if (result.error.includes('No cards available')) {
        errorMessage = ERROR_MESSAGES.NO_CARDS_AVAILABLE;
      } else if (result.error.includes('Failed to select card')) {
        errorMessage = ERROR_MESSAGES.FAILED_TO_SELECT_CARD;
      } else if (result.error.includes('Failed to record history')) {
        errorMessage = ERROR_MESSAGES.FAILED_TO_RECORD_HISTORY;
      } else if (result.error.includes('Database error')) {
        errorMessage = ERROR_MESSAGES.DATABASE_ERROR;
      } else if (result.error.includes('Streamer not found')) {
        errorMessage = ERROR_MESSAGES.STREAMER_NOT_FOUND;
      } else if (result.error.includes('Reward ID mismatch')) {
        errorMessage = ERROR_MESSAGES.REWARD_ID_MISMATCH;
      } else if (result.error.includes('Unexpected error')) {
        errorMessage = ERROR_MESSAGES.UNEXPECTED_ERROR;
      }

      return NextResponse.json<GachaErrorResponse>(
        { error: errorMessage },
        { status: 500 }
      );
    }

    return NextResponse.json<GachaSuccessResponse>(result.data);
  } catch (error) {
    if (session) {
      reportGachaError(error, {
        streamerId: body && typeof body === 'object' && 'streamerId' in body ? String(body.streamerId) : undefined,
        userId: session?.twitchUserId,
        cost: GACHA_COST,
      })
    } else {
      reportGachaError(error, {})
    }
    
    return handleApiError(error, "Gacha API");
  }
}
