import { NextRequest, NextResponse } from "next/server";
import type { Card } from "@/types/database";
import { logger } from "@/lib/logger";
import { createClient } from "@supabase/supabase-js";

// Demo cards for testing overlay (used when streamer has no cards)
// 配信者がカードを持っていない場合に使用されるデモカード
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
 * This endpoint returns a random card from streamer's cards (if available) or demo cards
 * デモガチャエンドポイント - 認証なしでオーバーレイをテスト
 * 配信者のカードがあればそれを、なければデモカードを返す
 *
 * @param request - POST request with optional streamerId and cardId in body
 *   - streamerId: 配信者ID（指定された場合、その配信者のカードを優先して返す）
 *   - cardId: カードID（指定された場合、そのカードを直接返す。"random"または未指定でランダム選択）
 */
export async function POST(request: NextRequest) {
  try {
    // リクエストボディからstreamerId, cardIdを取得（オプション）
    let streamerId: string | null = null;
    let cardId: string | null = null;
    try {
      const body = await request.json();
      streamerId = body.streamerId || null;
      cardId = body.cardId || null;
    } catch {
      // JSONパースエラーは無視（パラメータなしとして処理）
    }

    // Supabaseクライアントの初期化
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    // 特定のカードIDが指定されている場合、そのカードを直接取得
    // If specific cardId is provided, fetch that card directly
    if (cardId && cardId !== "random" && supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data: card, error } = await supabase
        .from("cards")
        .select("*")
        .eq("id", cardId)
        .single();

      if (!error && card) {
        return NextResponse.json({
          card,
          userTwitchUsername: "DemoUser",
        });
      }
      // カードが見つからない場合はランダム選択にフォールバック
    }

    // 配信者IDが指定されている場合、その配信者のカードを取得
    // If streamerId is provided, fetch streamer's cards
    if (streamerId && supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);

      // 配信者のアクティブなカードを取得
      const { data: cards, error } = await supabase
        .from("cards")
        .select("*")
        .eq("streamer_id", streamerId)
        .eq("is_active", true);

      if (!error && cards && cards.length > 0) {
        // 配信者のカードからランダムに選択
        // Select random card from streamer's cards
        const randomCard = cards[Math.floor(Math.random() * cards.length)];

        return NextResponse.json({
          card: randomCard,
          userTwitchUsername: "DemoUser",
        });
      }
    }

    // 配信者のカードがない場合、デモカードを使用
    // Use demo cards if streamer has no cards
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
    logger.error("Demo gacha error:", { error });
    return NextResponse.json(
      { error: "Failed to generate demo card" },
      { status: 500 }
    );
  }
}
