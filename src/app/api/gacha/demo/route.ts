import { NextRequest, NextResponse } from "next/server";
import type { Card } from "@/types/database";
import { logger } from "@/lib/logger.server";
import { getSession } from "@/lib/session";
import { getStreamerIdByTwitchUserId } from "@/lib/user-data";
import { ERROR_MESSAGES } from "@/lib/constants";
import { checkRateLimit, rateLimits, getRateLimitIdentifier } from "@/lib/rate-limit";
import type { ApiRateLimitResponse } from "@/types/api";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable } from "@/lib/db/schema";
import { CARDS_SAFE_COLUMNS, isMissingCardsBattleColumnError } from "@/lib/db/cards-safe-columns";
import { publishOverlayDemoEvent } from "@/lib/overlay/demo-event-store";

/**
 * Fetch one card from the authoritative PlanetScale database.
 *
 * #735: 元実装は is_active / streamer_id を一切見ずに任意の cardId を返していた
 * ため、id さえ分かれば非公開(inactive)カードの name/description/image_url を
 * 誰でも取得できた。streamerId を必須にし、指定 streamerId 配下の有効カードに
 * 絞る(streamerId を任意にすると、他streamerのidさえ知っていればactiveな
 * カードの内容とその所有streamer_idを無認証で引ける横断オラクルになるため)。
 * 実際の呼び出し元(OverlayPreview.tsx / overlay/[streamerId]/page.tsx)は常に
 * cardIdとstreamerIdを同時に渡すため、正規の利用を壊さない。
 * 絞り込みでヒットしない場合は null を返し、呼び出し側が streamerId の
 * ランダムカード → 組み込みデモカードへフォールバックする既存の縮退chainに
 * 委ねる。
 */
async function fetchCardByIdPg(cardId: string, streamerId: string): Promise<Card | null> {
  const condition = and(
    eq(cardsTable.id, cardId),
    eq(cardsTable.streamer_id, streamerId),
    eq(cardsTable.is_active, true)
  );

  async function selectRow(useSafeColumns: boolean) {
    return withDbRetry(
      async () => {
        const { db } = await getDb();
        const query = useSafeColumns ? db.select(CARDS_SAFE_COLUMNS) : db.select();
        return query.from(cardsTable).where(condition).limit(1);
      },
      "gacha/demo(fetch card by id)",
      { idempotent: true },
    );
  }

  try {
    let rows;
    try {
      rows = await selectRow(false);
    } catch (error) {
      if (!isMissingCardsBattleColumnError(error)) throw error;
      rows = await selectRow(true);
    }
    return (rows[0] as unknown as Card) ?? null;
  } catch {
    return null;
  }
}

/** Fetch active streamer cards from the authoritative PlanetScale database. */
async function fetchActiveCardsForStreamerPg(streamerId: string): Promise<Card[]> {
  async function selectRows(useSafeColumns: boolean) {
    return withDbRetry(
      async () => {
        const { db } = await getDb();
        const query = useSafeColumns ? db.select(CARDS_SAFE_COLUMNS) : db.select();
        return query
          .from(cardsTable)
          .where(and(eq(cardsTable.streamer_id, streamerId), eq(cardsTable.is_active, true)));
      },
      "gacha/demo(fetch streamer cards)",
      { idempotent: true },
    );
  }

  try {
    let rows;
    try {
      rows = await selectRows(false);
    } catch (error) {
      if (!isMissingCardsBattleColumnError(error)) throw error;
      rows = await selectRows(true);
    }
    return rows as unknown as Card[];
  } catch {
    return [];
  }
}

const DEMO_CARDS: Array<Omit<Card, 'id' | 'created_at' | 'updated_at' | 'streamer_id'>> = [
  {
    name: "デモカード - コモン",
    description: "これはデモ用のコモンカードです",
    rarity: "common",
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
    skill_type: "attack",
    skill_name: "通常攻撃",
    skill_power: 100,
    intra_rarity_weight: 1.0,
  },
  {
    name: "デモカード - レア",
    description: "これはデモ用のレアカードです",
    rarity: "rare",
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
    skill_type: "defense",
    skill_name: "防御強化",
    skill_power: 150,
    intra_rarity_weight: 1.0,
  },
  {
    name: "デモカード - エピック",
    description: "これはデモ用のエピックカードです",
    rarity: "epic",
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
    skill_type: "heal",
    skill_name: "回復",
    skill_power: 200,
    intra_rarity_weight: 1.0,
  },
  {
    name: "デモカード - レジェンダリー",
    description: "これはデモ用のレジェンダリーカードです",
    rarity: "legendary",
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
    skill_type: "special",
    skill_name: "必殺技",
    skill_power: 300,
    intra_rarity_weight: 1.0,
  },
];

/**
 * Public demo-card endpoint. Card reads are always served from PlanetScale.
 * `broadcast=true` publishes a short-lived KV demo event consumed by the same
 * polling endpoint as OBS, so no Supabase Realtime project is required.
 */
export async function POST(request: NextRequest) {
  try {
    let streamerId: string | null = null;
    let cardId: string | null = null;
    let broadcast = false;
    try {
      const body = await request.json();
      streamerId = body.streamerId || null;
      cardId = body.cardId || null;
      broadcast = body.broadcast === true;
    } catch {
      // Treat invalid/empty JSON as a parameterless public demo request.
    }

    // #735: このエンドポイントは意図的に無認証(OBSオーバーレイのデモ表示・
    // プレビューUIから直接呼ばれる)だが、レートリミットが無いと任意cardIdの
    // enumerationに使えてしまう。broadcast&&streamerId分岐は認証済みユーザーID
    // 基準のより厳格な専用制限(gachaDemoBroadcast)を別途持つため、そちらを通る
    // リクエストにはIPベースの制限を重ねない。同じ数値(30/分)の制限を先に
    // 無関係な匿名IPベースの枠で課すと、同一IPを共有する別人の連打だけで
    // 配信者自身のOBSデモボタンがブロックされ得るうえ、専用制限に一度も
    // 到達しなくなってしまう。
    if (!(broadcast && streamerId)) {
      const generalIdentifier = await getRateLimitIdentifier(request);
      const generalRateLimitResult = await checkRateLimit(rateLimits.gachaDemoCard, generalIdentifier);
      if (!generalRateLimitResult.success) {
        return NextResponse.json<ApiRateLimitResponse>(
          {
            error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
            retryAfter: (generalRateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
          },
          {
            status: 429,
            headers: {
              'X-RateLimit-Limit': String(generalRateLimitResult.limit),
              'X-RateLimit-Remaining': String(generalRateLimitResult.remaining),
              'X-RateLimit-Reset': String(generalRateLimitResult.reset),
            },
          }
        );
      }
    }

    if (broadcast && streamerId) {
      const session = await getSession();
      if (!session) {
        return NextResponse.json({ error: ERROR_MESSAGES.UNAUTHORIZED }, { status: 401 });
      }
      const ownedStreamer = await getStreamerIdByTwitchUserId(session.twitchUserId);
      if (!ownedStreamer || ownedStreamer.id !== streamerId) {
        return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
      }

      const identifier = await getRateLimitIdentifier(request, session.twitchUserId);
      const rateLimitResult = await checkRateLimit(rateLimits.gachaDemoBroadcast, identifier);
      if (!rateLimitResult.success) {
        return NextResponse.json<ApiRateLimitResponse>(
          {
            error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
            retryAfter: (rateLimitResult.reset || 0) - Math.floor(Date.now() / 1000),
          },
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

    const respondWithCard = async (card: Card, targetStreamerId: string | null) => {
      if (broadcast && targetStreamerId) {
        try {
          await publishOverlayDemoEvent(targetStreamerId, card);
          logger.info(`Demo polling event published for streamer ${targetStreamerId}`);
        } catch (publishError) {
          // Demo transport is non-business data; preserve the historical
          // best-effort response behaviour if KV is temporarily unavailable.
          logger.error("Failed to publish demo overlay event:", { publishError });
        }
      }
      return NextResponse.json({ card, userTwitchUsername: "DemoUser" });
    };

    // #735: streamerId が無いと、他streamerの任意のactiveカードを id だけで
    // 無認証取得できる横断オラクルになるため streamerId を必須にする。
    if (cardId && cardId !== "random" && streamerId) {
      const card = await fetchCardByIdPg(cardId, streamerId);
      if (card) return respondWithCard(card, streamerId);
    }

    if (streamerId) {
      const cards = await fetchActiveCardsForStreamerPg(streamerId);
      if (cards.length > 0) {
        const randomCard = cards[Math.floor(Math.random() * cards.length)];
        return respondWithCard(randomCard, streamerId);
      }
    }

    const randomCard = DEMO_CARDS[Math.floor(Math.random() * DEMO_CARDS.length)];
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
