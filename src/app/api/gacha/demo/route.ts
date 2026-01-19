import { NextResponse } from "next/server";
import type { Card } from "@/types/database";

// Demo cards for testing overlay
const DEMO_CARDS: Omit<Card, 'id' | 'created_at' | 'updated_at' | 'streamer_id'>[] = [
  {
    name: "デモカード - コモン",
    description: "これはデモ用のコモンカードです",
    rarity: "common",
    image_url: null,
  },
  {
    name: "デモカード - レア",
    description: "これはデモ用のレアカードです",
    rarity: "rare",
    image_url: null,
  },
  {
    name: "デモカード - エピック",
    description: "これはデモ用のエピックカードです",
    rarity: "epic",
    image_url: null,
  },
  {
    name: "デモカード - レジェンダリー",
    description: "これはデモ用のレジェンダリーカードです",
    rarity: "legendary",
    image_url: null,
  },
];

/**
 * Demo gacha endpoint for testing overlay without authentication
 * This endpoint returns a random demo card without requiring login or database access
 */
export async function POST() {
  try {
    // Select random card
    const randomCard = DEMO_CARDS[Math.floor(Math.random() * DEMO_CARDS.length)];

    // Create card object with required fields
    const card: Card = {
      ...randomCard,
      id: crypto.randomUUID(),
      streamer_id: 'demo',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return NextResponse.json({
      card,
      userTwitchUsername: "DemoUser",
    });
  } catch (error) {
    console.error("Demo gacha error:", error);
    return NextResponse.json(
      { error: "Failed to generate demo card" },
      { status: 500 }
    );
  }
}
