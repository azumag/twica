import { NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import { getTwitchAccessToken } from "@/lib/twitch/token-manager";
import { getCachedEmotes } from "@/lib/twitch/api-cache";

/**
 * Helper function to get Twitch access token or throw an error
 * Twitchアクセストークンを取得するか、エラーをスローするヘルパー関数
 */
async function getTwitchAccessTokenOrError(twitchUserId: string): Promise<string> {
  const accessToken = await getTwitchAccessToken(twitchUserId);
  if (accessToken === null) {
    throw new Error(ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED);
  }
  return accessToken;
}

/**
 * GET /api/twitch/emotes
 * Fetches the broadcaster's channel emotes from Twitch API
 * 配信者のチャンネルエモートをTwitch APIから取得
 */
export async function GET(request: Request) {
  const session = await getSession();

  // Rate limiting check
  // レート制限チェック
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

  // Authentication and authorization check
  // 認証・認可チェック
  if (!session || !canUseStreamerFeatures(session)) {
    return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
  }

  try {
    const accessToken = await getTwitchAccessTokenOrError(session.twitchUserId);

    // Use cached emotes to reduce Twitch API calls and CPU usage
    // キャッシュ済みエモートを使用してTwitch API呼び出しとCPU使用量を削減
    const emotes = await getCachedEmotes(session.twitchUserId, accessToken);
    return NextResponse.json(emotes);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '';
    if (errorMessage === ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.TWITCH_TOKEN_REQUIRED, requiresReauth: true },
        { status: 401 }
      );
    }
    return handleApiError(error, "Twitch emotes fetch");
  }
}
