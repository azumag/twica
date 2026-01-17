import { NextRequest, NextResponse } from "next/server";
import { GachaService } from "@/lib/services/gacha";
import { handleApiError } from "@/lib/error-handler";
import { getSession } from "@/lib/session";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { reportGachaError } from "@/lib/sentry/error-handler";
import { setUserContext, setRequestContext } from "@/lib/sentry/user-context";
import { GACHA_COST } from "@/lib/constants";

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
      return NextResponse.json(
        { error: "リクエストが多すぎます。しばらく待ってから再試行してください。" },
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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    body = await request.json();
    const { streamerId } = body as { streamerId?: string };

    if (!streamerId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const gachaService = new GachaService();
    const result = await gachaService.executeGacha(streamerId, session.twitchUserId, session.twitchUsername);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 500 }
      );
    }

    return NextResponse.json(result.data);
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
