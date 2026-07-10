import { NextRequest, NextResponse } from "next/server";
import type { Card } from "@/types/database";
import { logger } from "@/lib/logger";
import { createClient } from "@supabase/supabase-js";
import { broadcastGachaResult, GachaBroadcastPayload } from "@/lib/realtime";
import { getSupabaseElevatedKey, getSupabasePublicKey } from "@/lib/supabase/keys";
// -----------------------------------------------------------------------------
// #663: pg 直結経路（読み取り専用）の import。
// このルートは cards テーブルの読み取りのみのため isPgReadEnabled() で分岐する
// （書き込みを含む関数は isPgWriteEnabled() を使うが、本ルートには該当しない）。
// フラグ未設定時（既定 'postgrest'）は isPgReadEnabled() が false を返し getDb() は
// 一切呼ばれないため、既存の supabase-js 実装が従来どおり実行される（挙動不変）。
// -----------------------------------------------------------------------------
import { and, eq, getTableColumns } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isPgReadEnabled } from "@/lib/db/flags";
import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable } from "@/lib/db/schema";

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
 * cardId 指定時のカード取得（pg 直結実装, #663）
 *
 * PostgREST 実装（下記 POST 内の `.from("cards").select("*").eq("id", cardId)
 * .maybeSingle()`）との対応:
 * - id は主キー（migration 00001）のため一致行は最大1行。.maybeSingle() と同じ
 *   外部挙動を LIMIT 1 + `rows[0] ?? null` で再現する。
 * - 取得失敗（接続断・不正な cardId 形式による 22P02 等）は既存実装の
 *   `if (!error && card)` 分岐と同じく null を返し、呼び出し元でランダム選択
 *   （さらにはデモカード）へのフォールバックに委ねる。これは本ルートの最重要
 *   要件（エラー時はデモカードへ静かにフォールバックする既存挙動）を維持するため。
 * - 読み取り専用クエリのため冪等（idempotent: true）としてリトライを opt-in する。
 * - getTableColumns(cardsTable) の spread は Card 型に無い生成カラム rarity_order も
 *   含むが、PostgREST の `select("*")` も実 DB の全列（rarity_order 含む）を返す
 *   ため形状は一致する（dashboard-data.ts の getStreamerDataPg と同じ既知事項）。
 */
async function fetchCardByIdPg(cardId: string): Promise<Card | null> {
  try {
    const rows = await withDbRetry(
      async () => {
        // 規約: getDb() は queryFn の中で呼ぶ（リクエストスコープ破棄からの
        // 回復にはクライアント再取得が必要。src/lib/db/retry.ts 参照）
        const { db } = await getDb();
        return db
          .select({ ...getTableColumns(cardsTable) })
          .from(cardsTable)
          .where(eq(cardsTable.id, cardId))
          .limit(1);
      },
      "gacha/demo(cardById)",
      { idempotent: true },
    );
    return (rows[0] ?? null) as unknown as Card | null;
  } catch (error) {
    // 既存実装のエラー分岐と同じ外部挙動（null を返し呼び出し元でフォールバック）。
    logger.error("Demo gacha: failed to fetch card by id (pg)", { error });
    return null;
  }
}

/**
 * streamerId 指定時のアクティブカード一覧取得（pg 直結実装, #663）
 *
 * PostgREST 実装（下記 POST 内の `.from("cards").select("*").eq("streamer_id",
 * streamerId).eq("is_active", true)`）との対応:
 * - streamer_id 一致 かつ is_active = true の絞り込みをそのまま AND 条件として
 *   再現する。
 * - 取得失敗時は既存実装の `if (!error && cards && cards.length > 0)` 分岐と
 *   同じく空配列を返し、呼び出し元でデモカードへのフォールバックに委ねる。
 * - 読み取り専用クエリのため冪等（idempotent: true）としてリトライを opt-in する。
 */
async function fetchActiveCardsByStreamerPg(streamerId: string): Promise<Card[]> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return db
          .select({ ...getTableColumns(cardsTable) })
          .from(cardsTable)
          .where(
            and(eq(cardsTable.streamer_id, streamerId), eq(cardsTable.is_active, true)),
          );
      },
      "gacha/demo(cardsByStreamer)",
      { idempotent: true },
    );
    return rows as unknown as Card[];
  } catch (error) {
    logger.error("Demo gacha: failed to fetch streamer cards (pg)", { error });
    return [];
  }
}

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

    // 特定のカードIDが指定されている場合、そのカードを直接取得
    // If specific cardId is provided, fetch that card directly
    if (cardId && cardId !== "random") {
      // #663: 読み取り専用のためフラグは isPgReadEnabled() で分岐。
      // フラグ未設定時（既定 'postgrest'）は else 節（既存 supabase-js 実装、
      // 無変更）が従来どおり実行される。
      if (isPgReadEnabled()) {
        const card = await fetchCardByIdPg(cardId);
        if (card) {
          return respondWithCard(card, streamerId);
        }
        // カードが見つからない場合はランダム選択にフォールバック
      } else if (supabaseUrl && supabaseKey) {
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { data: card, error } = await supabase
          .from("cards")
          .select("*")
          .eq("id", cardId)
          .maybeSingle();

        if (!error && card) {
          return respondWithCard(card, streamerId);
        }
        // カードが見つからない場合はランダム選択にフォールバック
      }
    }

    // 配信者IDが指定されている場合、その配信者のカードを取得
    // If streamerId is provided, fetch streamer's cards
    if (streamerId) {
      // #663: 読み取り専用のためフラグは isPgReadEnabled() で分岐。
      if (isPgReadEnabled()) {
        const cards = await fetchActiveCardsByStreamerPg(streamerId);
        if (cards.length > 0) {
          // 配信者のカードからランダムに選択
          const randomCard = cards[Math.floor(Math.random() * cards.length)];

          return respondWithCard(randomCard, streamerId);
        }
      } else if (supabaseUrl && supabaseKey) {
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

          return respondWithCard(randomCard, streamerId);
        }
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
