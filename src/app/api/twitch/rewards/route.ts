import { NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { getTwitchAccessToken, TwitchTokenError } from "@/lib/twitch/token-manager";
import { validateCSRFToken } from "@/lib/csrf";
import { reportError } from "@/lib/sentry/error-handler";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

function handleTwitchTokenError(error: TwitchTokenError, twitchUserId: string): never {
  const errorMessages: Record<TwitchTokenError['code'], string> = {
    'NO_TOKEN': ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED,
    'REFRESH_FAILED': ERROR_MESSAGES.TWITCH_TOKEN_REFRESH_FAILED,
    'DATABASE_ERROR': 'サーバーエラーが発生しました。',
  };

  reportError(error, {
    context: 'getTwitchAccessToken',
    code: error.code,
    userId: twitchUserId
  });

  const wrappedError = new Error(errorMessages[error.code] || 'サーバーエラーが発生しました。');
  wrappedError.stack = error.stack;
  throw wrappedError;
}

async function getTwitchAccessTokenOrError(twitchUserId: string): Promise<string> {
  try {
    const accessToken = await getTwitchAccessToken(twitchUserId);
    return accessToken;
  } catch (error) {
    if (error instanceof TwitchTokenError) {
      if (error.code === 'NO_TOKEN') {
        throw new Error(ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED);
      }
      handleTwitchTokenError(error, twitchUserId);
    }
    reportError(error, {
      context: 'getTwitchAccessToken',
      userId: twitchUserId
    });
    const wrappedError = new Error('サーバーエラーが発生しました。');
    wrappedError.stack = error instanceof Error ? error.stack : undefined;
    throw wrappedError;
  }
}

export async function GET(request: Request) {
  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.twitchRewardsGet, identifier);

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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const accessToken = await getTwitchAccessTokenOrError(session.twitchUserId);

    const response = await fetch(
      `${TWITCH_API_URL}/channel_points/custom_rewards?broadcaster_id=${session.twitchUserId}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      return handleApiError(error, "Twitch API rewards fetch");
    }

    const data = await response.json();
    return NextResponse.json(data.data || []);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage === ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED, requiresReauth: true },
        { status: 401 }
      );
    }
    return handleApiError(error, "Twitch rewards fetch");
  }
}

export async function POST(request: Request) {
  const csrfValidation = await validateCSRFToken(request)
  if (!csrfValidation.valid) {
    return NextResponse.json(
      { error: ERROR_MESSAGES.FORBIDDEN },
      { status: 403 }
    )
  }

  const session = await getSession();

  const identifier = await getRateLimitIdentifier(request, session?.twitchUserId);
  const rateLimitResult = await checkRateLimit(rateLimits.twitchRewardsPost, identifier);

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

  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const accessToken = await getTwitchAccessTokenOrError(session.twitchUserId);
    const response = await fetch(
      `${TWITCH_API_URL}/channel_points/custom_rewards?broadcaster_id=${session.twitchUserId}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": process.env.TWITCH_CLIENT_ID!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "TwiCa カードガチャ",
          cost: 100,
          prompt: "カードガチャを1回引きます",
          is_enabled: true,
          background_color: "#9147FF",
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      return handleApiError(error, "Twitch API reward creation");
    }

    const data = await response.json();
    return NextResponse.json(data.data[0]);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage === ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED, requiresReauth: true },
        { status: 401 }
      );
    }
    return handleApiError(error, "Twitch reward creation");
  }
}
