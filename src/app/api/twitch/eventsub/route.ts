import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import crypto from "crypto";
import { GachaService } from "@/lib/services/gacha";
import { TWITCH_SUBSCRIPTION_TYPE } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";
import { logger } from "@/lib/logger";

// Twitch EventSub message types
const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";

// Store for SSE connections (in production, use Redis or similar)
const sseConnections = new Map<string, Set<ReadableStreamDefaultController>>();

export function addSSEConnection(streamerId: string, controller: ReadableStreamDefaultController) {
  if (!sseConnections.has(streamerId)) {
    sseConnections.set(streamerId, new Set());
  }
  sseConnections.get(streamerId)!.add(controller);
}

export function removeSSEConnection(streamerId: string, controller: ReadableStreamDefaultController) {
  sseConnections.get(streamerId)?.delete(controller);
}

export function notifySSEClients(streamerId: string, data: object) {
  const connections = sseConnections.get(streamerId);
  if (connections) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    connections.forEach((controller) => {
      try {
        controller.enqueue(new TextEncoder().encode(message));
      } catch {
        // Connection closed
        connections.delete(controller);
      }
    });
  }
}

// Verify Twitch signature
function verifyTwitchSignature(
  messageId: string,
  timestamp: string,
  body: string,
  signature: string
): boolean {
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  if (!secret) return false;

  const message = messageId + timestamp + body;
  const expectedSignature = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(signature)
  );
}

export async function POST(request: NextRequest) {
  const body = await request.text();

  const messageId = request.headers.get("twitch-eventsub-message-id") || "";
  const timestamp = request.headers.get("twitch-eventsub-message-timestamp") || "";
  const messageType = request.headers.get("twitch-eventsub-message-type") || "";
  const signature = request.headers.get("twitch-eventsub-message-signature") || "";

  // Verify signature
  if (!verifyTwitchSignature(messageId, timestamp, body, signature)) {
    logger.error("Invalid Twitch signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const data = JSON.parse(body);

  // Handle verification challenge
  if (messageType === MESSAGE_TYPE_VERIFICATION) {
    return new NextResponse(data.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Handle revocation
  if (messageType === MESSAGE_TYPE_REVOCATION) {
    return NextResponse.json({ received: true });
  }

  // Handle notification
  if (messageType === MESSAGE_TYPE_NOTIFICATION) {
    const subscriptionType = data.subscription.type;
    const event = data.event;

    // Handle channel point redemption
    if (subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD) {
      await handleRedemption(event);
    }

    return NextResponse.json({ received: true });
  }

  return NextResponse.json({ error: "Unknown message type" }, { status: 400 });
}

async function handleRedemption(event: {
  broadcaster_user_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  reward: { id: string; title: string };
}) {
  try {
    const gachaService = new GachaService();
    const result = await gachaService.executeGachaForEventSub(event);

    if (!result.success) {
      // Log error but don't throw, as webhook should return 200
      logger.error("Gacha failed:", result.error);
      return;
    }

    // Notify overlay via SSE
    const gachaResult = {
      type: "gacha",
      card: result.data.card,
      userTwitchUsername: result.data.userTwitchUsername,
    };

    // Get streamer ID for SSE
    const supabaseAdmin = getSupabaseAdmin();
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id")
      .eq("twitch_user_id", event.broadcaster_user_id)
      .single();

    if (streamer) {
      notifySSEClients(streamer.id, gachaResult);
    }
  } catch (error) {
    return handleApiError(error, "EventSub redemption");
  }
}
