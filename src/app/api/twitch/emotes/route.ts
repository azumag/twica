import { NextResponse } from "next/server";
import { getSession, canUseStreamerFeatures } from "@/lib/session";
import { handleApiError } from "@/lib/error-handler";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import { ERROR_MESSAGES } from "@/lib/constants";
import {
  handleTwitchTokenError,
  requireTwitchAccessToken,
} from "@/lib/twitch/token-error-handler";

const TWITCH_API_URL = "https://api.twitch.tv/helix";

/**
 * Twitch emote data structure from API response
 * Twitch APIレスポンスのエモートデータ構造
 */
interface TwitchEmote {
  id: string;
  name: string;
  images: {
    url_1x: string;
    url_2x: string;
    url_4x: string;
  };
  tier: string;
  emote_type: string;
  emote_set_id: string;
  format: string[];
  scale: string[];
  theme_mode: string[];
}

/**
 * GET /api/twitch/emotes
 * Fetches the broadcaster's channel emotes from Twitch API
 * 配信者のチャネルエモートをTwitch APIから取得
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
    const accessToken = await requireTwitchAccessToken(session.twitchUserId);

    // Fetch channel emotes from Twitch API
    // Twitch APIからチャネルエモートを取得
    const response = await fetch(
      `${TWITCH_API_URL}/chat/emotes?broadcaster_id=${session.twitchUserId}`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Client-Id": process.env.NEXT_PUBLIC_TWITCH_CLIENT_ID!,
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      return handleApiError(error, "Twitch API emotes fetch");
    }

    const data = await response.json();
    const emotes: TwitchEmote[] = data.data || [];

    // Transform emotes to a simpler format for the client
    // クライアント用にエモートをシンプルな形式に変換
    const transformedEmotes = emotes.map((emote) => ({
      id: emote.id,
      name: emote.name,
      // Use 4x (largest) image for card quality, fall back to 2x or 1x
      // カード品質のため4x（最大）画像を使用、なければ2xまたは1xにフォールバック
      imageUrl: emote.images.url_4x || emote.images.url_2x || emote.images.url_1x,
      tier: emote.tier,
      emoteType: emote.emote_type,
    }));

    return NextResponse.json(transformedEmotes);
  } catch (error) {
    // Issue #1088: token error の catch を共通ヘルパへ集約する。
    // - トークン未保持(MissingTwitchTokenError): 記録せず 401 + requiresReauth。
    // - 恒久refresh失効(#1018 の channel-point-bootstrap と同型: NO_TOKEN /
    //   REFRESH_FAILED 400・401): 診断記録を維持したまま 401 + requiresReauth。
    // - 一過性5xx/network/DB起因: 従来どおり500(handleApiError)。
    return handleTwitchTokenError(error, "Twitch emotes fetch");
  }
}
