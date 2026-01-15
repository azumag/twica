import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import crypto from "crypto";
import { selectWeightedCard } from "@/lib/gacha";
import { TWITCH_SUBSCRIPTION_TYPE } from "@/lib/constants";

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
    console.error("Invalid Twitch signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const data = JSON.parse(body);

  // Handle verification challenge
  if (messageType === MESSAGE_TYPE_VERIFICATION) {
    console.log("EventSub verification challenge received");
    return new NextResponse(data.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Handle revocation
  if (messageType === MESSAGE_TYPE_REVOCATION) {
    console.log("EventSub subscription revoked:", data.subscription);
    return NextResponse.json({ received: true });
  }

  // Handle notification
  if (messageType === MESSAGE_TYPE_NOTIFICATION) {
    const event = data.event;
    const subscriptionType = data.subscription.type;

    console.log("EventSub notification:", subscriptionType, event);

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
  const supabaseAdmin = getSupabaseAdmin();

  try {
    // Find streamer by twitch_user_id and matching reward_id
    const { data: streamer } = await supabaseAdmin
      .from("streamers")
      .select("id, channel_point_reward_id")
      .eq("twitch_user_id", event.broadcaster_user_id)
      .single();

    if (!streamer) {
      console.log("Streamer not found for broadcaster:", event.broadcaster_user_id);
      return;
    }

    // Check if this is the configured reward
    if (streamer.channel_point_reward_id !== event.reward.id) {
      console.log("Reward ID mismatch, ignoring redemption");
      return;
    }

    // Get random card for this streamer
    const { data: cards } = await supabaseAdmin
      .from("cards")
      .select("*")
      .eq("streamer_id", streamer.id)
      .eq("is_active", true);

    if (!cards || cards.length === 0) {
      console.log("No active cards for streamer");
      return;
    }

    const selectedCard = selectWeightedCard(cards);

    if (!selectedCard) {
      console.log("Failed to select card");
      return;
    }

    // Ensure user exists
    await supabaseAdmin
      .from("users")
      .upsert({
        twitch_user_id: event.user_id,
        twitch_username: event.user_login,
        twitch_display_name: event.user_name,
      }, {
        onConflict: "twitch_user_id",
      });

    // Get user ID
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("twitch_user_id", event.user_id)
      .single();

    if (!user) {
      console.error("Failed to get/create user");
      return;
    }

    // Add card to user's collection
    await supabaseAdmin
      .from("user_cards")
      .insert({
        user_id: user.id,
        card_id: selectedCard.id,
      });

    // Record gacha history
    await supabaseAdmin
      .from("gacha_history")
      .insert({
        user_id: user.id,
        card_id: selectedCard.id,
        streamer_id: streamer.id,
      });

    // Notify overlay via SSE
    const gachaResult = {
      type: "gacha",
      card: selectedCard,
      userTwitchUsername: event.user_name,
    };

    notifySSEClients(streamer.id, gachaResult);

    console.log(`Gacha result: ${event.user_name} got ${selectedCard.name} (${selectedCard.rarity})`);
  } catch (error) {
    console.error("Error handling redemption:", error);
  }
}
