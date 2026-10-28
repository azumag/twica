import { NextRequest, NextResponse } from "next/server";
import type { Card } from "@/types/database";
import { logger } from "@/lib/logger.server";
import { getSession } from "@/lib/session";
import { getStreamerIdByTwitchUserId } from "@/lib/user-data";
import { ERROR_MESSAGES } from "@/lib/constants";
import { validateCSRFToken } from "@/lib/csrf";
import { checkRateLimit, rateLimits, getRateLimitIdentifier, retryAfterSeconds } from "@/lib/rate-limit";
import type { ApiRateLimitResponse } from "@/types/api";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { withDbRetry } from "@/lib/db/retry";
import { cards as cardsTable, streamers as streamersTable } from "@/lib/db/schema";
import {
  createOverlayDemoEvent,
  storeOverlayDemoEvent,
} from "@/lib/overlay/demo-event-store";
import { publishOverlayDemoRealtimeEvent } from "@/lib/overlay-realtime/publisher";
import { runInBackground } from "@/lib/background-task";

/**
 * オーバーレイのデモ表示に実際に使うカードのフィールド。
 *
 * overlay/[streamerId]/page.tsx は card.{id,name,description,image_url,
 * image_padding_color,rarity} しか参照せず、createOverlayDemoEvent（KV/DO へ流す
 * イベント）も同じ6項目だけを使う。このエンドポイントは無認証で呼べるため、
 * drop_rate / max_issuance_count / ステータス値などの表示に不要な列（=配信者の
 * 内部設計情報）は SELECT もレスポンスもしない（最小限の列だけ返す）。
 */
type OverlayDemoCard = Pick<
  Card,
  "id" | "name" | "description" | "image_url" | "image_padding_color" | "rarity"
>;

/** db.select() に渡す列。`select()` の全列取得にしないための明示リスト。 */
const OVERLAY_CARD_COLUMNS = {
  id: cardsTable.id,
  name: cardsTable.name,
  description: cardsTable.description,
  image_url: cardsTable.image_url,
  image_padding_color: cardsTable.image_padding_color,
  rarity: cardsTable.rarity,
};

/** 任意の Card（組み込みデモカード含む）からオーバーレイ表示用の列だけを取り出す。 */
function toOverlayDemoCard(card: OverlayDemoCard): OverlayDemoCard {
  return {
    id: card.id,
    name: card.name,
    description: card.description,
    image_url: card.image_url,
    image_padding_color: card.image_padding_color ?? null,
    rarity: card.rarity,
  };
}

/**
 * 実カード取得のアクセスモード。
 *
 * - "owner": broadcast 分岐（セッションと所有権を検証済みのログイン中の配信者本人）。
 *   自分のカードなので公開設定に関係なく実カードを使える。
 * - "public": 無認証を含むそれ以外。コレクションページと同じ公開設定に従い、配信者が
 *   `show_unowned_cards` と `show_unowned_card_details` の「両方」をオンにしている
 *   場合だけ実カードを返す。どちらかがオフなら、未所持カードの存在・名前・画像を
 *   見せない設定のため取得結果は空になり、呼び出し側が組み込みデモカードへ縮退する。
 *   （これが無いと、OBS 用に URL を知られた/推測された配信者の非公開カードを、
 *   誰でもこの無認証 API から取得できてしまう。）
 *   公開設定は streamers との JOIN 条件で判定し、1クエリで原子的に絞り込む
 *   （別クエリで先に確認する方式は確認後の設定変更との競合を生み、往復も増える）。
 */
type CardAccess = "owner" | "public";

/** 条件に合うオーバーレイ表示用カードを取得する（access に応じて公開設定で絞る）。 */
function selectOverlayCards(
  db: Awaited<ReturnType<typeof getDb>>["db"],
  condition: ReturnType<typeof and>,
  access: CardAccess,
) {
  if (access === "owner") {
    return db.select(OVERLAY_CARD_COLUMNS).from(cardsTable).where(condition);
  }
  return db
    .select(OVERLAY_CARD_COLUMNS)
    .from(cardsTable)
    .innerJoin(streamersTable, eq(streamersTable.id, cardsTable.streamer_id))
    .where(
      and(
        condition,
        eq(streamersTable.show_unowned_cards, true),
        eq(streamersTable.show_unowned_card_details, true),
      ),
    );
}

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
 *
 * 加えて access="public" では配信者の未所持カード公開設定（CardAccess 参照）を
 * 満たさない場合も null を返す。
 */
async function fetchCardByIdPg(
  cardId: string,
  streamerId: string,
  access: CardAccess,
): Promise<OverlayDemoCard | null> {
  const condition = and(
    eq(cardsTable.id, cardId),
    eq(cardsTable.streamer_id, streamerId),
    eq(cardsTable.is_active, true)
  );

  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return selectOverlayCards(db, condition, access).limit(1);
      },
      "gacha/demo(fetch card by id)",
      { idempotent: true },
    );
    return (rows[0] as unknown as OverlayDemoCard) ?? null;
  } catch (error) {
    // #834 でこの分岐の列欠落フォールバック（本番未デプロイ8列）は撤去済み。
    // 撤去後は列欠落を含むあらゆる失敗がここに到達し、呼び出し元の縮退chain
    // （streamerId のランダムカード → 組み込みデモカード）へ黙って倒れるため、
    // 調査可能性のためログだけは残す（挙動自体は変更しない）。
    logger.error("gacha/demo: fetchCardByIdPg failed", { error });
    return null;
  }
}

/** Fetch active streamer cards from the authoritative PlanetScale database. */
async function fetchActiveCardsForStreamerPg(
  streamerId: string,
  access: CardAccess,
): Promise<OverlayDemoCard[]> {
  try {
    const rows = await withDbRetry(
      async () => {
        const { db } = await getDb();
        return selectOverlayCards(
          db,
          and(eq(cardsTable.streamer_id, streamerId), eq(cardsTable.is_active, true)),
          access,
        );
      },
      "gacha/demo(fetch streamer cards)",
      { idempotent: true },
    );
    return rows as unknown as OverlayDemoCard[];
  } catch (error) {
    // fetchCardByIdPg と同じ理由でログを残す（#834 で列欠落フォールバックを撤去済み）。
    logger.error("gacha/demo: fetchActiveCardsForStreamerPg failed", { error });
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
    image_padding_color: null,
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
    image_padding_color: null,
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
    image_padding_color: null,
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
    image_padding_color: null,
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
 * `broadcast=true` stores a short-lived KV fallback and sends the same event
 * through the signed Durable Object transport used by OBS. This preserves an
 * immediate demo while avoiding a permanent fast polling loop or Supabase.
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
            retryAfter: retryAfterSeconds(generalRateLimitResult.reset),
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

    // #1331: 公開デモカード取得は読み取り用途として意図的に無認証のまま維持する。
    // session Cookie で KV / Overlay Realtime へ状態変更する broadcast 分岐だけが
    // CSRF の対象であり、エンドポイント全体へ検証を広げて公開デモを壊さない。
    if (broadcast && streamerId) {
      const csrfValidation = await validateCSRFToken(request);
      if (!csrfValidation.valid) {
        return NextResponse.json({ error: ERROR_MESSAGES.FORBIDDEN }, { status: 403 });
      }

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
            retryAfter: retryAfterSeconds(rateLimitResult.reset),
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

    // broadcast 分岐は上で CSRF・セッション・所有権を検証済みの配信者本人だけが到達する。
    // それ以外（無認証含む）は公開設定に従う（CardAccess 参照）。
    const access: CardAccess = broadcast && streamerId ? "owner" : "public";

    const respondWithCard = async (card: OverlayDemoCard, targetStreamerId: string | null) => {
      if (broadcast && targetStreamerId) {
        const demoEvent = createOverlayDemoEvent(card);

        // Start both transports before awaiting either one. The KV fallback
        // and immediate Durable Object fanout are independent best-effort
        // paths: a rejected KV write must not suppress socket delivery, and a
        // rejected/failed publisher must not suppress fallback persistence.
        // Both receive the exact same frozen event, preserving cross-transport
        // identity and preventing timing-dependent payload divergence.
        const fallbackTask = storeOverlayDemoEvent(targetStreamerId, demoEvent);
        const realtimeTask = publishOverlayDemoRealtimeEvent(targetStreamerId, demoEvent);
        const deliveryTask = Promise.allSettled([fallbackTask, realtimeTask]).then(
          ([fallbackResult, realtimeResult]) => {
            if (fallbackResult.status === "fulfilled") {
              logger.info("Demo overlay KV fallback stored", { streamerId: targetStreamerId });
            } else {
              logger.error("Demo overlay KV fallback failed", {
                streamerId: targetStreamerId,
                error: fallbackResult.reason instanceof Error
                  ? fallbackResult.reason.name
                  : "unknown",
              });
            }

            if (realtimeResult.status === "rejected") {
              logger.error("Demo overlay realtime publish rejected", {
                streamerId: targetStreamerId,
                error: realtimeResult.reason instanceof Error
                  ? realtimeResult.reason.name
                  : "unknown",
              });
              return;
            }

            const { outcome, attempts, errorCode } = realtimeResult.value;
            const context = { streamerId: targetStreamerId, attempts, errorCode };
            if (outcome === "accepted") {
              logger.info("Demo overlay realtime publish accepted", context);
            } else if (outcome === "skipped") {
              logger.warn("Demo overlay realtime publish skipped", context);
            } else {
              // The publisher reports exhausted retries and validation errors
              // as a fulfilled `failed` outcome, not a rejected Promise. Keep
              // that operational failure out of the success log classification.
              logger.error("Demo overlay realtime publish failed", context);
            }
          },
        );

        // In Workers this registers already-started delivery with waitUntil and
        // lets the API response return immediately. Local/test runtimes await
        // the same all-settled task, which prevents unhandled rejections while
        // preserving the production response-lifetime boundary.
        await runInBackground("overlay demo delivery", deliveryTask);
      }
      // レスポンスの card は常に表示用6項目だけに絞る（取得側で絞り損ねても、
      // 組み込みデモカードも含め、余計な列が無認証レスポンスに混ざらないようにする最終防衛）。
      return NextResponse.json({ card: toOverlayDemoCard(card), userTwitchUsername: "DemoUser" });
    };

    // #735: streamerId が無いと、他streamerの任意のactiveカードを id だけで
    // 無認証取得できる横断オラクルになるため streamerId を必須にする。
    if (cardId && cardId !== "random" && streamerId) {
      const card = await fetchCardByIdPg(cardId, streamerId, access);
      if (card) return respondWithCard(card, streamerId);
    }

    if (streamerId) {
      const cards = await fetchActiveCardsForStreamerPg(streamerId, access);
      if (cards.length > 0) {
        const randomCard = cards[Math.floor(Math.random() * cards.length)];
        return respondWithCard(randomCard, streamerId);
      }
    }

    const randomCard = DEMO_CARDS[Math.floor(Math.random() * DEMO_CARDS.length)];
    const card: OverlayDemoCard = { ...randomCard, id: crypto.randomUUID() };
    return respondWithCard(card, streamerId);
  } catch (error) {
    logger.error("Demo gacha error:", { error });
    return NextResponse.json(
      { error: "Failed to generate demo card" },
      { status: 500 }
    );
  }
}
