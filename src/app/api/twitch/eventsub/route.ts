import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import crypto from "crypto";
import { GachaService } from "@/lib/services/gacha";
import { TWITCH_SUBSCRIPTION_TYPE, ERROR_MESSAGES } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";
import { broadcastGachaResult } from "@/lib/realtime";
import { checkRateLimit, rateLimits, getClientIp } from "@/lib/rate-limit";

const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";

function verifyTwitchSignature(
  messageId: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  const secret = process.env.TWITCH_EVENTSUB_SECRET;

  // Debug logging for signature verification issues
  // デバッグ用：署名検証の問題を特定するためのログ出力
  console.log("[EventSub] Signature verification:", {
    hasSecret: !!secret,
    secretLength: secret?.length || 0,
    hasSignature: !!signature,
    messageId,
    timestamp,
    bodyLength: body.length,
  });

  if (!secret || !signature) {
    console.log("[EventSub] Missing secret or signature");
    return false;
  }

  const message = messageId + timestamp + body;
  const expectedSignature = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  // Debug: Compare first/last few chars of signatures (safe to log)
  // デバッグ用：署名の最初と最後の数文字を比較（ログに出力しても安全）
  console.log("[EventSub] Signature comparison:", {
    receivedPrefix: signature.substring(0, 15),
    expectedPrefix: expectedSignature.substring(0, 15),
    receivedSuffix: signature.substring(signature.length - 8),
    expectedSuffix: expectedSignature.substring(expectedSignature.length - 8),
    lengthMatch: signature.length === expectedSignature.length,
  });

  try {
    const result = crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature)
    );
    console.log("[EventSub] Signature verification result:", result);
    return result;
  } catch (e) {
    console.log("[EventSub] Signature verification error:", e);
    return false;
  }
}

export async function POST(request: NextRequest) {
  // Debug: Log incoming request for EventSub troubleshooting
  // デバッグ用：EventSubのトラブルシューティングのため、受信リクエストをログ出力
  console.log("[EventSub] Incoming request from:", request.headers.get("user-agent"));

  const body = await request.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    console.log("[EventSub] JSON parse error:", e);
    return handleApiError(e, "EventSub JSON parsing");
  }

  const messageId = request.headers.get("twitch-eventsub-message-id") || "";
  const timestamp = request.headers.get("twitch-eventsub-message-timestamp") || "";
  const messageType = request.headers.get("twitch-eventsub-message-type") || "";
  const signature = request.headers.get("twitch-eventsub-message-signature") || "";

  // Debug: Log message type for verification tracking
  // デバッグ用：検証追跡のためメッセージタイプをログ出力
  console.log("[EventSub] Message type:", messageType, "| Challenge present:", !!data.challenge);

  if (!verifyTwitchSignature(messageId, timestamp, body, signature)) {
    console.log("[EventSub] Signature verification FAILED - returning 403");
    return NextResponse.json({ error: ERROR_MESSAGES.INVALID_SIGNATURE }, { status: 403 });
  }

  console.log("[EventSub] Signature verification PASSED");

  if (messageType !== MESSAGE_TYPE_NOTIFICATION) {
    const ip = getClientIp(request);
    const identifier = `ip:${ip}`;
    const rateLimitResult = await checkRateLimit(rateLimits.eventsub, identifier);

    if (!rateLimitResult.success) {
      return NextResponse.json(
{ error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED },
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
  }

  if (messageType === MESSAGE_TYPE_NOTIFICATION) {
    const subscriptionType = data.subscription.type;
    const event = data.event;

    if (subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD) {
      await handleRedemption(messageId, event);
    }

    return NextResponse.json({ received: true });
  }

  if (messageType === MESSAGE_TYPE_VERIFICATION) {
    return new NextResponse(data.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (messageType === MESSAGE_TYPE_REVOCATION) {
    return NextResponse.json({ received: true });
  }

  return NextResponse.json({ error: ERROR_MESSAGES.UNKNOWN_MESSAGE_TYPE }, { status: 400 });
}

async function handleRedemption(messageId: string, event: {
  broadcaster_user_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  reward: { id: string; title: string };
}) {
  const supabaseAdmin = getSupabaseAdmin();

  // Idempotency check - skip if this event was already processed
  const { data: existingHistory } = await supabaseAdmin
    .from('gacha_history')
    .select('id')
    .eq('event_id', messageId)
    .single();

  if (existingHistory) {
    return;
  }

  try {
    const gachaService = new GachaService();
    const result = await gachaService.executeGachaForEventSub(event, messageId);

    if (!result.success) {
      // Error in gacha but don't throw, as webhook should return 200
      return;
    }

    // Notify overlay via Supabase Realtime
    const gachaResult = {
      type: "gacha" as const,
      card: result.data.card,
      userTwitchUsername: result.data.userTwitchUsername,
    };

    // Get streamer ID for broadcast
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", event.broadcaster_user_id)
      .single();

    if (streamer) {
      await broadcastGachaResult(streamer.id, gachaResult, {
        maxRetries: 3,
        retryDelay: 1000,
      });
    }
  } catch (error) {
    return handleApiError(error, "EventSub redemption");
  }
}
