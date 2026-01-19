import { NextResponse } from "next/server";
import type { Card } from "@/types/database";

// Demo cards for testing overlay
const DEMO_CARDS: Array<Omit<Card, 'id' | 'created_at' | 'updated_at' | 'streamer_id'>> = [
  {
    name: "デモカード - コモン",
    description: "これはデモ用のコモンカードです",
    rarity: "common" as const,
    image_url: null,
    drop_rate: 50,
    is_active: true,
    hp: 100,
    atk: 50,
    def: 40,
    spd: 60,
    skill_type: "attack" as const,
    skill_name: "通常攻撃",
    skill_power: 100,
  },
  {
    name: "デモカード - レア",
    description: "これはデモ用のレアカードです",
    rarity: "rare" as const,
    image_url: null,
    drop_rate: 30,
    is_active: true,
    hp: 150,
    atk: 70,
    def: 60,
    spd: 70,
    skill_type: "defense" as const,
    skill_name: "防御強化",
    skill_power: 150,
  },
  {
    name: "デモカード - エピック",
    description: "これはデモ用のエピックカードです",
    rarity: "epic" as const,
    image_url: null,
    drop_rate: 15,
    is_active: true,
    hp: 200,
    atk: 90,
    def: 80,
    spd: 80,
    skill_type: "heal" as const,
    skill_name: "回復",
    skill_power: 200,
  },
  {
    name: "デモカード - レジェンダリー",
    description: "これはデモ用のレジェンダリーカードです",
    rarity: "legendary" as const,
    image_url: null,
    drop_rate: 5,
    is_active: true,
    hp: 300,
    atk: 120,
    def: 100,
    spd: 100,
    skill_type: "special" as const,
    skill_name: "必殺技",
    skill_power: 300,
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
