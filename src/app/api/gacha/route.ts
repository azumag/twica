import { NextRequest, NextResponse } from "next/server";
import { GachaService } from "@/lib/services/gacha";
import { getSession } from "@/lib/session";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { reportGachaError } from "@/lib/sentry/error-handler";
import { setUserContext, setRequestContext } from "@/lib/sentry/user-context";
import { GACHA_COST, ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { validateContentType } from "@/lib/request-validation";
import { broadcastGachaResult, GachaBroadcastPayload } from "@/lib/realtime";
import { logger } from "@/lib/logger";
import type { GachaSuccessResponse, GachaErrorResponse, ApiRateLimitResponse } from "@/types/api";

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID()
  setRequestContext(requestId, '/api/gacha')

  let session: { twitchUserId: string; twitchUsername: string; broadcasterType?: string } | null = null
  let body: Record<string, unknown> | null = null

  try {
    // Content-Type validation - must be the first check
    const contentTypeValidation = validateContentType(request, 'application/json')
    if (contentTypeValidation) {
      return contentTypeValidation
    }

    const csrfValidation = await validateCSRFToken(request)
    if (!csrfValidation.valid) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.FORBIDDEN },
        { status: 403 }
      )
    }

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
    // Issue #661: execute_gacha_transaction RPC は p_event_id (Twitch EventSub の
    // messageId) を唯一の重複防止キーとして使う (gacha_history.event_id の
    // UNIQUE制約 + ON CONFLICT DO NOTHING)。このエンドポイントは EventSub を
    // 経由しないため元々 eventId を渡しておらず、RPCへは p_event_id=null が
    // 渡っていた。NULL同士はUNIQUE制約上「重複」とみなされないため、
    // RPC側はNULLでの呼び出しを明示的に拒否するようになった(migration
    // 00073)。ここで毎回一意な合成IDを渡すことで、この手動ドローAPIの
    // 既存挙動(呼ぶたびに新しい抽選として成功する)を変えずにNULL拒否と
    // 両立させる。
    const manualDrawEventId = `manual:${crypto.randomUUID()}`;
    const result = await gachaService.executeGacha(
      streamerId,
      session.twitchUserId,
      session.twitchUsername,
      manualDrawEventId
    );

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

    // ガチャ成功時、オーバーレイにリアルタイム通知を送信
    // Broadcast gacha result to overlay via Supabase Realtime
    const payload: GachaBroadcastPayload = {
      type: "gacha",
      card: {
        id: result.data.card.id,
        name: result.data.card.name,
        description: result.data.card.description,
        image_url: result.data.card.image_url,
        rarity: result.data.card.rarity,
      },
      userTwitchUsername: result.data.userTwitchUsername,
    };

    // broadcastGachaResult は内部でリトライし、失敗時も throw しない設計
    // （OBSオーバーレイへの通知のみで、ガチャ処理の成否に影響しないため Issue #359-#365）
    // 失敗ログは broadcastGachaResult 内で warn として出力される
    await broadcastGachaResult(streamerId, payload);
    logger.info(`Gacha result broadcast attempted for streamer ${streamerId}`);

    return NextResponse.json<GachaSuccessResponse>({
      card: result.data.card
    });
  } catch (error) {
    // reportGachaError が [Gacha Error] タイプで Supabase 記録 + console.error を行う
    if (session) {
      await reportGachaError(error, {
        streamerId: body && typeof body === 'object' && 'streamerId' in body ? String(body.streamerId) : undefined,
        userId: session?.twitchUserId,
        cost: GACHA_COST,
      })
    } else {
      await reportGachaError(error, {})
    }

    return NextResponse.json({ error: ERROR_MESSAGES.INTERNAL_ERROR }, { status: 500 });
  }
}
