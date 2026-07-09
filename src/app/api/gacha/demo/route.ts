import { NextRequest, NextResponse } from "next/server";
import type { Card } from "@/types/database";
import { logger } from "@/lib/logger";
import { createClient } from "@supabase/supabase-js";
import { broadcastGachaResult, GachaBroadcastPayload } from "@/lib/realtime";
import { getSupabaseElevatedKey, getSupabasePublicKey } from "@/lib/supabase/keys";
// ---------------------------------------------------------------------------
// #663 (#570 パイロット踏襲): pg 直結経路。フラグ未設定時（既定 'postgrest'）は
// isPgReadEnabled() が false を返すため getDb() は一切呼ばれず、既存の
// supabase-js 経路が従来どおり実行される。
//
// この route は他の対象ファイルと異なり getSupabaseAdmin() を使わず、都度
// createClient(supabaseUrl, supabaseKey) でアドホックなクライアントを生成する
// （認証不要の公開デモエンドポイントのため service-role キーが未設定の環境でも
// anon キーで動作するようにする設計）。pg 直結経路は Hyperdrive/DATABASE_URL
// 経由で接続するため supabaseUrl/supabaseKey の設定有無に依存せず動作する。
// ---------------------------------------------------------------------------
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable } from "@/lib/db/schema";

/**
 * cardId 直接指定時のカード取得の pg 直結実装 (#663)
 * PostgREST 実装との対応: .maybeSingle() は id が PK のため最大 1 行、
 * LIMIT 1 + rows[0] ?? null で同じ外部挙動。既存コードは取得失敗時に
 * ランダム選択へフォールバックするだけで throw しないため、pg 版もエラーは
 * 握りつぶして null を返す（同じフォールバック挙動）。
 */
async function fetchCardByIdPg(cardId: string): Promise<Card | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db.select().from(cardsTable).where(eq(cardsTable.id, cardId)).limit(1);
      },
      "gacha/demo(fetch card by id)",
      { idempotent: true },
    );
    return (rows[0] as unknown as Card) ?? null;
  } catch {
    return null;
  }
}

/**
 * 配信者のアクティブカード一覧取得の pg 直結実装 (#663)
 * PostgREST 実装との対応: .eq('streamer_id', ...).eq('is_active', true) は
 * and(eq(...), eq(...)) と等価。既存コードは取得失敗時にデモカードへ
 * フォールバックするだけで throw しないため、pg 版もエラーは握りつぶして
 * 空配列を返す（同じフォールバック挙動）。
 */
async function fetchActiveCardsForStreamerPg(streamerId: string): Promise<Card[]> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select()
          .from(cardsTable)
          .where(and(eq(cardsTable.streamer_id, streamerId), eq(cardsTable.is_active, true)));
      },
      "gacha/demo(fetch streamer cards)",
      { idempotent: true },
    );
    return rows as unknown as Card[];
  } catch {
    return [];
  }
}

// Demo cards for testing overlay (used when streamer has no cards)
// 配信者がカードを持っていない場合に使用されるデモカード
const DEMO_CARDS: Array<Omit<Card, 'id' | 'created_at' | 'updated_at' | 'streamer_id'>> = [
  {
    name: "デモカード - コモン",
    description: "これはデモ用のコモンカードです",
    rarity: "common" as const,
    card_number: null,
    max_issuance_count: null,
    collection_name: null,
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
    intra_rarity_weight: 1.0,
  },
  {
    name: "デモカード - レア",
    description: "これはデモ用のレアカードです",
    rarity: "rare" as const,
    card_number: null,
    max_issuance_count: null,
    collection_name: null,
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
    intra_rarity_weight: 1.0,
  },
  {
    name: "デモカード - エピック",
    description: "これはデモ用のエピックカードです",
    rarity: "epic" as const,
    card_number: null,
    max_issuance_count: null,
    collection_name: null,
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
    intra_rarity_weight: 1.0,
  },
  {
    name: "デモカード - レジェンダリー",
    description: "これはデモ用のレジェンダリーカードです",
    rarity: "legendary" as const,
    card_number: null,
    max_issuance_count: null,
    collection_name: null,
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
    intra_rarity_weight: 1.0,
  },
];

/**
 * Demo gacha endpoint for testing overlay without authentication
 * This endpoint returns a random card from streamer's cards (if available) or demo cards
 * デモガチャエンドポイント - 認証なしでオーバーレイをテスト
 * 配信者のカードがあればそれを、なければデモカードを返す
 *
 * @param request - POST request with optional streamerId, cardId, and broadcast in body
 *   - streamerId: 配信者ID（指定された場合、その配信者のカードを優先して返す）
 *   - cardId: カードID（指定された場合、そのカードを直接返す。"random"または未指定でランダム選択）
 *   - broadcast: boolean（trueの場合、Supabase RealtimeでOBSに送信）
 */
export async function POST(request: NextRequest) {
  try {
    // リクエストボディからstreamerId, cardId, broadcastを取得（オプション）
    // Parse streamerId, cardId, and broadcast from request body (all optional)
    let streamerId: string | null = null;
    let cardId: string | null = null;
    let broadcast: boolean = false;
    try {
      const body = await request.json();
      streamerId = body.streamerId || null;
      cardId = body.cardId || null;
      broadcast = body.broadcast === true;
    } catch {
      // JSONパースエラーは無視（パラメータなしとして処理）
    }

    // Supabaseクライアントの初期化
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = getSupabaseElevatedKey() || getSupabasePublicKey();

    // ブロードキャストとレスポンス返却を行うヘルパー関数
    // Helper function to optionally broadcast and return response
    const respondWithCard = async (card: Card, targetStreamerId: string | null) => {
      const userTwitchUsername = "DemoUser";

      // broadcast=trueかつstreamerIdが指定されている場合、OBSにリアルタイム送信
      // Broadcast to OBS via Supabase Realtime if broadcast=true and streamerId is provided
      if (broadcast && targetStreamerId) {
        const payload: GachaBroadcastPayload = {
          type: "gacha",
          card: {
            id: card.id,
            name: card.name,
            description: card.description,
            image_url: card.image_url,
            rarity: card.rarity,
          },
          userTwitchUsername,
        };

        try {
          await broadcastGachaResult(targetStreamerId, payload);
          logger.info(`Demo broadcast sent to streamer ${targetStreamerId}`);
        } catch (broadcastError) {
          // ブロードキャストエラーはログに記録するが、レスポンスは返す
          // Log broadcast errors but still return response
          logger.error("Failed to broadcast demo result:", { broadcastError });
        }
      }

      return NextResponse.json({ card, userTwitchUsername });
    };

    const hasSupabaseCreds = !!(supabaseUrl && supabaseKey);

    // 特定のカードIDが指定されている場合、そのカードを直接取得
    // If specific cardId is provided, fetch that card directly
    // #663: 読み取り専用のため isPgReadEnabled() で分岐。pg 経路は
    // supabaseUrl/supabaseKey の設定有無に依存しない（doc コメント参照）。
    if (cardId && cardId !== "random" && (isPgReadEnabled() || hasSupabaseCreds)) {
      let card: Card | null = null;
      if (isPgReadEnabled()) {
        card = await fetchCardByIdPg(cardId);
      } else if (supabaseUrl && supabaseKey) {
        const supabase = createClient(supabaseUrl, supabaseKey);
        const result = await supabase.from("cards").select("*").eq("id", cardId).maybeSingle();
        card = result.data;
      }

      if (card) {
        return respondWithCard(card, streamerId);
      }
      // カードが見つからない場合はランダム選択にフォールバック
    }

    // 配信者IDが指定されている場合、その配信者のカードを取得
    // If streamerId is provided, fetch streamer's cards
    // #663: 読み取り専用のため isPgReadEnabled() で分岐。
    if (streamerId && (isPgReadEnabled() || hasSupabaseCreds)) {
      let cards: Card[] | null = null;
      if (isPgReadEnabled()) {
        cards = await fetchActiveCardsForStreamerPg(streamerId);
      } else if (supabaseUrl && supabaseKey) {
        const supabase = createClient(supabaseUrl, supabaseKey);
        const result = await supabase
          .from("cards")
          .select("*")
          .eq("streamer_id", streamerId)
          .eq("is_active", true);
        cards = result.data;
      }

      if (cards && cards.length > 0) {
        // 配信者のカードからランダムに選択
        // Select random card from streamer's cards
        const randomCard = cards[Math.floor(Math.random() * cards.length)];

        return respondWithCard(randomCard, streamerId);
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

    return respondWithCard(card, streamerId);
  } catch (error) {
    logger.error("Demo gacha error:", { error });
    return NextResponse.json(
      { error: "Failed to generate demo card" },
      { status: 500 }
    );
  }
}
