import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, getSupabaseAdminNoCache } from "@/lib/supabase/admin";
import { GachaService } from "@/lib/services/gacha";
import { TWITCH_CHAT_MESSAGE_MAX_CHARACTERS, TWITCH_SUBSCRIPTION_TYPE, ERROR_MESSAGES } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";
import { broadcastGachaResult } from "@/lib/realtime";
import { checkRateLimit, rateLimits, getClientIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { reportError } from "@/lib/sentry/error-handler";
import { TwitchChatService, DEFAULT_CHAT_TEMPLATE, type ChatMessagePlaceholders } from "@/lib/twitch/chat-service";
import type { GachaCard, EventSubStreamerInfo } from "@/lib/services/gacha";
import { countCharacters } from "@/lib/text-utils";

const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";
const CARD_LIST_SEPARATOR = "、";
const DEFAULT_MULTI_DRAW_CHAT_TEMPLATE = '@{user} が{draws}連ガチャで {rarityCounts} を獲得しました！{cards}';

function formatCardNamesForChat(cardNames: string[], maxCharacters: number): string {
  if (cardNames.length === 0) return "";

  const fullList = cardNames.join(CARD_LIST_SEPARATOR);
  if (countCharacters(fullList) <= maxCharacters) {
    return fullList;
  }

  const total = cardNames.length;
  const displayed: string[] = [];

  for (const cardName of cardNames) {
    const nextDisplayed = [...displayed, cardName];
    const remaining = total - nextDisplayed.length;
    const suffix = remaining > 0 ? ` ほか${remaining}枚（${nextDisplayed.length}/${total}枚表示）` : "";
    const candidate = `${nextDisplayed.join(CARD_LIST_SEPARATOR)}${suffix}`;

    if (countCharacters(candidate) > maxCharacters) {
      break;
    }

    displayed.push(cardName);
  }

  if (displayed.length === 0) {
    const fallback = `ほか${total}枚（0/${total}枚表示）`;
    return countCharacters(fallback) <= maxCharacters ? fallback : `全${total}枚`;
  }

  const remaining = total - displayed.length;
  return `${displayed.join(CARD_LIST_SEPARATOR)} ほか${remaining}枚（${displayed.length}/${total}枚表示）`;
}

function fitCardNamesForMessage(
  cardNames: string[],
  renderMessage: (cardsText: string) => string,
  // 後段で必ず追記される接尾辞分の文字数を予約しておくことで、
  // 「初出:」追記時の二段階圧縮で末尾切り（truncateCharacters）に陥るのを防ぐ。
  // Reserve characters for a suffix that will be appended later (e.g., " 初出: ...").
  // Without this, the second fit pass cannot shrink {cards} enough and the suffix gets truncated.
  reservedSuffixCharacters: number = 0
): { cardsText: string; message: string } {
  const effectiveLimit = Math.max(0, TWITCH_CHAT_MESSAGE_MAX_CHARACTERS - reservedSuffixCharacters);
  let cardsText = cardNames.join(CARD_LIST_SEPARATOR);
  let message = renderMessage(cardsText);

  for (let i = 0; i < 3 && countCharacters(message) > effectiveLimit; i++) {
    const overflow = countCharacters(message) - effectiveLimit;
    const nextMaxCharacters = Math.max(0, countCharacters(cardsText) - overflow);
    cardsText = formatCardNamesForChat(cardNames, nextMaxCharacters);
    message = renderMessage(cardsText);
  }

  return { cardsText, message };
}

function formatRarityCountsForChat(cardNamesByRarity: string[]): string {
  if (cardNamesByRarity.length === 0) return "";

  const counts = new Map<string, number>();
  for (const rarity of cardNamesByRarity) {
    counts.set(rarity, (counts.get(rarity) ?? 0) + 1);
  }

  const rarityOrder = ["legendary", "epic", "rare", "common"];
  const rarityMap: Record<string, string> = {
    common: 'コモン',
    rare: 'レア',
    epic: 'エピック',
    legendary: 'レジェンダリー',
  };

  return [...counts.entries()]
    .sort(([a], [b]) => {
      const aIndex = rarityOrder.indexOf(a);
      const bIndex = rarityOrder.indexOf(b);
      return (aIndex === -1 ? rarityOrder.length : aIndex)
        - (bIndex === -1 ? rarityOrder.length : bIndex);
    })
    .map(([rarity, count]) => `${rarityMap[rarity] ?? rarity}x${count}`)
    .join(CARD_LIST_SEPARATOR);
}

function findNewCardNamesForCurrentDraw(
  drawnCards: GachaCard[],
  userCardCounts: Array<{ count: number; card: { id: string; is_active?: boolean } }>
): string[] {
  const drawnCounts = new Map<string, number>();
  for (const drawnCard of drawnCards) {
    drawnCounts.set(drawnCard.id, (drawnCounts.get(drawnCard.id) ?? 0) + 1);
  }

  const finalCounts = new Map<string, number>();
  for (const row of userCardCounts) {
    if (!row.card?.id) continue;
    finalCounts.set(row.card.id, Number(row.count) || 0);
  }

  const seenInCurrentDraw = new Set<string>();
  const newCardNames: string[] = [];

  for (const drawnCard of drawnCards) {
    if (seenInCurrentDraw.has(drawnCard.id)) continue;

    const finalCount = finalCounts.get(drawnCard.id);
    if (finalCount === undefined) {
      seenInCurrentDraw.add(drawnCard.id);
      continue;
    }

    const currentDrawCount = drawnCounts.get(drawnCard.id) ?? 0;
    const previousCount = finalCount - currentDrawCount;
    // legacy fallback で user_cards INSERT が失敗すると finalCount=0 のまま返り、
    // previousCount が負値になって「初出」誤通知が発生する。
    // 「初出」と判定するには「いま実際に所持している（finalCount > 0）」必要がある。
    // If legacy fallback INSERT fails, finalCount stays 0 while currentDrawCount > 0,
    // making previousCount negative. Treat as "new card" only when the user actually owns it.
    if (finalCount > 0 && previousCount <= 0) {
      newCardNames.push(drawnCard.name);
    }
    seenInCurrentDraw.add(drawnCard.id);
  }

  return newCardNames;
}

/**
 * Verify Twitch EventSub signature using HMAC-SHA256 (Web Crypto API)
 * Twitch EventSubの署名をHMAC-SHA256で検証（Web Crypto API使用）
 *
 * Web Crypto APIを使用することでCloudflare Workers/Edge Runtimeでも動作可能
 * This uses Web Crypto API for compatibility with Cloudflare Workers/Edge Runtime
 */
async function verifyTwitchSignature(
  messageId: string,
  timestamp: string,
  body: string,
  signature: string
): Promise<boolean> {
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  if (!secret || !signature) return false;

  try {
    const encoder = new TextEncoder();
    const message = messageId + timestamp + body;

    // Import the secret as an HMAC key
    // シークレットをHMACキーとしてインポート
    const keyData = encoder.encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Generate the HMAC signature
    // HMAC署名を生成
    const messageData = encoder.encode(message);
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, messageData);
    const signatureArray = Array.from(new Uint8Array(signatureBuffer));
    const expectedSignature = 'sha256=' + signatureArray
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time comparison to prevent timing attacks
    // タイミング攻撃を防ぐための定数時間比較
    if (expectedSignature.length !== signature.length) {
      return false;
    }

    let isValid = true;
    for (let i = 0; i < expectedSignature.length; i++) {
      if (expectedSignature[i] !== signature[i]) {
        isValid = false;
        // Don't break early to maintain constant time
        // 定数時間を維持するため早期breakしない
      }
    }

    return isValid;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return handleApiError(e, "EventSub JSON parsing");
  }

  const messageId = request.headers.get("twitch-eventsub-message-id") || "";
  const timestamp = request.headers.get("twitch-eventsub-message-timestamp") || "";
  const messageType = request.headers.get("twitch-eventsub-message-type") || "";
  const signature = request.headers.get("twitch-eventsub-message-signature") || "";

  // Verify signature asynchronously (Web Crypto API is async)
  // 署名を非同期で検証（Web Crypto APIは非同期）
  if (!await verifyTwitchSignature(messageId, timestamp, body, signature)) {
    return NextResponse.json({ error: ERROR_MESSAGES.INVALID_SIGNATURE }, { status: 403 });
  }

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

    // EventSub通知受信を記録（webhookが到達していることを確認するため）
    logger.info('[EventSub] Notification received', {
      messageId,
      subscriptionType,
      broadcasterUserId: event?.broadcaster_user_id,
    });

    if (subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_POINTS_REDEMPTION_ADD) {
      // ガチャ実行のみawaitし、通知処理はwaitUntil()で遅延実行してCPU時間を削減
      // Only await gacha execution; defer notifications via waitUntil() to reduce CPU time
      const result = await handleRedemption(messageId, event);
      if (result) {
        try {
          // Cloudflare Workers の waitUntil() でレスポンス返却後にバックグラウンド実行
          const { getCloudflareContext } = await import('@opennextjs/cloudflare');
          const { ctx } = await getCloudflareContext({ async: true });
          ctx.waitUntil(postRedemptionNotify(result));
        } catch (e) {
          // ローカル開発等で getCloudflareContext が使えない場合は同期フォールバック
          // Fallback to sync execution when getCloudflareContext is unavailable (local dev)
          logger.warn('[EventSub] waitUntil unavailable, falling back to sync', {
            error: e instanceof Error ? e.message : String(e),
          });
          await postRedemptionNotify(result);
        }
      }
    } else if (subscriptionType === TWITCH_SUBSCRIPTION_TYPE.CHANNEL_RAID) {
      const result = await handleRaidNotification(messageId, event);
      if (result) {
        try {
          const { getCloudflareContext } = await import('@opennextjs/cloudflare');
          const { ctx } = await getCloudflareContext({ async: true });
          ctx.waitUntil(postRedemptionNotify(result));
        } catch (e) {
          logger.warn('[EventSub] waitUntil unavailable for raid gift, falling back to sync', {
            error: e instanceof Error ? e.message : String(e),
          });
          await postRedemptionNotify(result);
        }
      }
    }

    return NextResponse.json({ received: true });
  }

  if (messageType === MESSAGE_TYPE_VERIFICATION) {
    // Webhook検証リクエストを受信したことをログに記録
    const subscription = data.subscription;
    logger.info(
      `EventSub verification received: type=${subscription?.type}, broadcaster=${subscription?.condition?.broadcaster_user_id}`,
      { challenge: data.challenge ? "present" : "missing" }
    );

    return new NextResponse(data.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (messageType === MESSAGE_TYPE_REVOCATION) {
    // EventSubが無効化された理由をログに記録
    // Revocation reasons: authorization_revoked, user_removed, notification_failures_exceeded, version_removed
    const subscription = data.subscription;
    const revocationReason = subscription?.status || "unknown";
    const subscriptionType = subscription?.type || "unknown";
    const broadcasterId = subscription?.condition?.broadcaster_user_id || "unknown";

    // ユーザー起因のrevocationはGitHub Issue化せずログのみ (Issue #285)
    // User-initiated revocations are expected behavior, not bugs
    const EXPECTED_REVOCATIONS = ['authorization_revoked', 'user_removed'];
    if (EXPECTED_REVOCATIONS.includes(revocationReason)) {
      logger.info(
        `EventSub revocation (user-initiated): reason=${revocationReason}, type=${subscriptionType}, broadcaster=${broadcasterId}`,
        { subscription }
      );
    } else {
      // インフラ問題等の予期しないrevocationはreportErrorでGitHub Issue化
      // Unexpected revocations (e.g. notification_failures_exceeded) indicate infrastructure issues
      logger.warn(
        `EventSub revocation (unexpected): reason=${revocationReason}, type=${subscriptionType}, broadcaster=${broadcasterId}`,
        { subscription }
      );
      await reportError(new Error(`EventSub revocation: ${revocationReason}`), {
        context: "eventsub:revocation",
        type: "eventsub",
        revocationReason,
        subscriptionType,
        broadcasterId,
        subscriptionId: subscription?.id,
      });
    }

    return NextResponse.json({ received: true });
  }

  return NextResponse.json({ error: ERROR_MESSAGES.UNKNOWN_MESSAGE_TYPE }, { status: 400 });
}

async function handleRaidNotification(messageId: string, event: {
  from_broadcaster_user_id?: string;
  from_broadcaster_user_login?: string;
  from_broadcaster_user_name?: string;
  to_broadcaster_user_id?: string;
  to_broadcaster_user_login?: string;
  to_broadcaster_user_name?: string;
  viewers?: number;
}): Promise<RedemptionNotifyData | null> {
  const toBroadcasterUserId = event.to_broadcaster_user_id;
  const fromBroadcasterUserId = event.from_broadcaster_user_id;
  if (!toBroadcasterUserId || !fromBroadcasterUserId) {
    logger.warn("[EventSub] Raid notification missing broadcaster id", { messageId, event });
    return null;
  }

  const gachaService = new GachaService();
  const result = await gachaService.executeGachaForRaidEvent({
    to_broadcaster_user_id: toBroadcasterUserId,
    from_broadcaster_user_id: fromBroadcasterUserId,
    from_broadcaster_user_login: event.from_broadcaster_user_login,
    from_broadcaster_user_name: event.from_broadcaster_user_name,
  }, messageId);

  if (!result.success) {
    if (result.error === 'Raid gacha disabled') {
      logger.info("[EventSub] Raid gacha gift skipped because it is disabled", {
        messageId,
        toBroadcasterUserId,
        fromBroadcasterUserId,
      });
      return null;
    }
    if (result.error === 'Duplicate event') {
      logger.info("[EventSub] Raid gacha gift skipped - duplicate event", { messageId });
      return null;
    }
    if (result.error === 'No cards available for this streamer') {
      logger.warn("[EventSub] Raid gacha gift skipped - no cards available", {
        messageId,
        toBroadcasterUserId,
      });
      return null;
    }
    await reportError(new Error(`Raid gacha gift failed: ${result.error}`), {
      context: "eventsub:handleRaidNotification",
      messageId,
      toBroadcasterUserId,
      fromBroadcasterUserId,
      gachaError: result.error,
    });
    return null;
  }

  const streamer = result.data.streamer;
  if (!streamer) {
    logger.warn("[EventSub] Raid gacha gift missing streamer info", { messageId });
    return null;
  }

  logger.info("[EventSub] Raid gacha gift succeeded", {
    messageId,
    streamerId: streamer.id,
    toBroadcasterUserId,
    fromBroadcasterUserId,
    viewers: event.viewers,
    drawCount: result.data.cards?.length ?? 1,
  });

  return {
    gachaResult: {
      type: "gacha",
      card: result.data.card,
      cards: result.data.cards,
      userTwitchUsername: result.data.userTwitchUsername,
    },
    broadcasterTwitchUserId: toBroadcasterUserId,
    streamer,
    userId: fromBroadcasterUserId,
  };
}

/** postRedemptionNotify に渡すデータ（streamer.id を streamerId として再利用し冗長を排除） */
interface RedemptionNotifyData {
  gachaResult: {
    type: "gacha";
    card: GachaCard;
    cards?: GachaCard[];
    userTwitchUsername: string;
    rewardId?: string | null;
  };
  broadcasterTwitchUserId: string;
  streamer: EventSubStreamerInfo;
  userId: string;
}

/**
 * ガチャ結果確定後の通知処理（ブロードキャスト + チャット通知）
 * waitUntil() でレスポンス返却後にバックグラウンド実行される。
 * broadcastとchatは独立しているためPromise.allSettledで並列実行する。
 *
 * Post-redemption notifications (broadcast + chat) run after response via waitUntil().
 * broadcast and chat are independent, so execute in parallel with Promise.allSettled.
 */
async function postRedemptionNotify(data: RedemptionNotifyData): Promise<void> {
  const results = await Promise.allSettled([
    // Realtime通知: waitUntil内でもCPU時間は有限のためリトライを1回に制限
    broadcastGachaResult(data.streamer.id, data.gachaResult, {
      maxRetries: 1,
      retryDelay: 500,
    }),
    sendChatAnnouncement(
      data.broadcasterTwitchUserId,
      data.streamer,
      data.gachaResult.card,
      data.gachaResult.userTwitchUsername,
      data.userId,
      data.gachaResult.cards
    ),
  ]);

  // 通知失敗をログ出力 + エラー追跡
  // Note: broadcastGachaResult (i=0) は内部でリトライし失敗時も throw しない設計 (Issue #359-#365)
  // そのため broadcast は 'rejected' にならず、失敗ログは broadcastGachaResult 内で warn として出力される
  // chatAnnouncement (i=1) は引き続きエラー時に throw するため、こちらのみ reportError が機能する
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      const label = i === 0 ? 'broadcast' : 'chatAnnouncement';
      logger.warn(`[postRedemptionNotify] ${label} failed`, {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        streamerId: data.streamer.id,
      });
      await reportError(result.reason, {
        context: `eventsub:postRedemptionNotify:${label}`,
        streamerId: data.streamer.id,
        broadcasterTwitchUserId: data.broadcasterTwitchUserId,
      });
    }
  }
}

/**
 * ガチャ実行とデータ準備を行い、通知に必要なデータを返す。
 * 通知処理自体は呼び出し元で waitUntil() により遅延実行される。
 *
 * Execute gacha and prepare data for notifications.
 * Actual notification is deferred by caller via waitUntil().
 *
 * @returns 通知データ（通知不要な場合はnull）
 */
async function handleRedemption(messageId: string, event: {
  broadcaster_user_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  reward: { id: string; title: string; cost?: number };
}): Promise<RedemptionNotifyData | null> {
  logger.info('[handleRedemption] START', {
    messageId,
    broadcasterUserId: event.broadcaster_user_id,
    userName: event.user_name,
    rewardTitle: event.reward.title,
  });

  const supabaseAdmin = getSupabaseAdmin();

  // 事前の冪等性チェック：既に処理済みのイベントはスキップ
  // RPC内でもON CONFLICTで重複を検知するが、事前チェックがないと
  // ストリーマー設定やカード構成が変わった後のリトライで
  // "Reward ID mismatch" や "No cards available" として誤報告されるため、
  // この事前SELECTは必要（レビュー指摘 P2）
  const { data: existingHistory } = await supabaseAdmin
    .from('gacha_history')
    .select('id')
    .eq('event_id', messageId)
    .maybeSingle();

  if (existingHistory) {
    logger.info('[handleRedemption] Skipped - already processed', { messageId });
    return null;
  }

  try {
    const gachaService = new GachaService();
    const result = await gachaService.executeGachaForEventSub(event, messageId);

    if (!result.success) {
      // EventSub重複通知は正常系（リトライによる再送）なのでエラー報告しない
      // Duplicate event is expected (EventSub retry) - don't report as error
      if (result.error === 'Duplicate event') {
        logger.info('[handleRedemption] Skipped - duplicate event (RPC)', { messageId });
        return null;
      }
      // 設定から外れた報酬の古い EventSub 通知は運用状態のズレであり、
      // production error としてGitHub Issue化しない。
      if (result.error === 'Reward ID mismatch') {
        logger.warn('[handleRedemption] Reward ID mismatch - stale or unconfigured EventSub notification', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
          rewardId: event.reward.id,
        });
        return null;
      }
      if (result.error === 'Raid-limited reward inactive') {
        logger.info('[handleRedemption] Raid-limited reward skipped outside active raid window', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
          rewardId: event.reward.id,
        });
        return null;
      }
      // カード未設定はユーザー設定の問題でありバグではない (Issue #277)
      // "No cards available" is a streamer setup issue, not a system bug
      if (result.error === 'No cards available for this streamer') {
        logger.warn('[handleRedemption] No cards available - streamer setup issue', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
        });
        return null;
      }
      // 削除済み/未登録 broadcaster の古い EventSub 通知は設定起因であり、
      // production error としてGitHub Issue化しない。
      if (result.error === 'Streamer not found') {
        logger.warn('[handleRedemption] Streamer not found - stale or unconfigured EventSub notification', {
          messageId,
          broadcasterUserId: event.broadcaster_user_id,
        });
        return null;
      }
      logger.warn('[handleRedemption] Gacha execution failed', { messageId });
      await reportError(new Error(`Gacha execution failed: ${result.error}`), {
        context: 'eventsub:handleRedemption',
        messageId,
        broadcasterUserId: event.broadcaster_user_id,
        gachaError: result.error,
      });
      return null;
    }

    logger.info('[handleRedemption] Gacha success', {
      messageId,
      cardName: result.data.card.name,
    });

    // ストリーマー情報は executeGachaForEventSub のクエリ統合で取得済み
    // Streamer info already fetched in the unified query within executeGachaForEventSub
    const streamer = result.data.streamer;
    if (!streamer) {
      logger.warn('[handleRedemption] No streamer info in gacha result', { messageId });
      return null;
    }

    const gachaResult = {
      type: "gacha" as const,
      card: result.data.card,
      cards: result.data.cards,
      userTwitchUsername: result.data.userTwitchUsername,
      rewardId: result.data.rewardId ?? event.reward.id,
    };

    logger.info('[handleRedemption] END', { messageId });

    return {
      gachaResult,
      broadcasterTwitchUserId: event.broadcaster_user_id,
      streamer,
      userId: event.user_id,
    };
  } catch (error) {
    // awaitしないとCloudflare Workersがレスポンス返却後にPromiseを打ち切り、
    // Supabaseへのエラー記録が失われる
    await handleApiError(error, `EventSub redemption (messageId=${messageId})`);
    return null;
  }
}

/**
 * チャット通知を送信する
 * Send chat announcement for gacha result
 *
 * @param broadcasterTwitchUserId - 配信者のTwitchユーザーID
 * @param streamer - 配信者の設定情報
 * @param card - 獲得したカード（GachaCard型 - gacha serviceから返される）
 * @param userName - ガチャを引いたユーザー名
 * @param userId - ガチャを引いたユーザーのTwitch ID
 * @param cards - 複数枚ガチャ時の獲得カード一覧
 */
async function sendChatAnnouncement(
  broadcasterTwitchUserId: string,
  streamer: {
    id: string;
    chat_announcement_enabled: boolean;
    chat_announcement_template: string | null;
    chat_announcement_multi_template: string | null;
    chat_announcement_multi_show_cards: boolean;
  },
  card: GachaCard,
  userName: string,
  userId: string,
  cards?: GachaCard[]
): Promise<void> {
  const drawnCards = cards && cards.length > 0 ? cards : [card];
  const isMultiDraw = drawnCards.length > 1;
  const cardNames = drawnCards.map((drawnCard) => drawnCard.name);
  const rarityCounts = formatRarityCountsForChat(drawnCards.map((drawnCard) => drawnCard.rarity));

  // 関数呼び出しを記録（デバッグ用：この関数が呼ばれたことを確認するため）
  // Log function entry to confirm this function is being called
  logger.info('sendChatAnnouncement called', {
    broadcasterTwitchUserId,
    streamerId: streamer.id,
    chatAnnouncementEnabled: streamer.chat_announcement_enabled,
    cardName: card.name,
    drawCount: drawnCards.length,
    userName,
  });

  // チャット通知が無効の場合はスキップ
  // Skip if chat announcement is disabled
  if (!streamer.chat_announcement_enabled) {
    // 無効状態を明示的にログ出力（以前は無言リターンでデバッグ困難だった）
    // Explicitly log disabled state (previously returned silently, making debugging impossible)
    logger.info('Chat announcement skipped - feature disabled', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
    });
    return;
  }

  // レアリティの日本語/英語変換マップ
  // Rarity translation map
  const rarityMap: Record<string, string> = {
    common: 'コモン',
    rare: 'レア',
    epic: 'エピック',
    legendary: 'レジェンダリー',
  };

  // テンプレートに含まれるプレースホルダーに応じてのみDBクエリを実行
  // waitUntil内のwall time短縮のため、不要なDBクエリをスキップ
  // Run DB queries only for placeholders that appear in the template to keep waitUntil wall-time short
  const messageTemplate = isMultiDraw
    ? streamer.chat_announcement_multi_template || DEFAULT_MULTI_DRAW_CHAT_TEMPLATE
    : streamer.chat_announcement_template || DEFAULT_CHAT_TEMPLATE;
  const usesMultiDrawPlaceholders = /\{cards\}|\{draws\}|\{rarityCounts\}|\{newCards\}|\{newCardCount\}/.test(messageTemplate);
  const effectiveTemplate = messageTemplate;
  const needsCardCount = /\{num\}/.test(effectiveTemplate);
  const needsUniqueCount = /\{unique\}/.test(effectiveTemplate);
  const needsAllCount = /\{all\}/.test(effectiveTemplate);
  const usesNewCardPlaceholders = /\{newCards\}|\{newCardCount\}/.test(effectiveTemplate);
  const shouldAppendDefaultNewCards = isMultiDraw
    && streamer.chat_announcement_multi_show_cards
    && !streamer.chat_announcement_multi_template;
  const needsNewCardInfo = isMultiDraw
    && streamer.chat_announcement_multi_show_cards
    && (usesNewCardPlaceholders || shouldAppendDefaultNewCards);

  let cardCount: number | undefined;
  let uniqueCount: number | undefined;
  let allCount: number | undefined;
  let newCardNames: string[] = [];

  if (needsCardCount || needsUniqueCount || needsAllCount || needsNewCardInfo) {
    const supabaseAdminNoCache = getSupabaseAdminNoCache();

    // {all} は配信者のアクティブカード総数のため、直接 cards テーブルを count クエリ
    // {all}: count active cards for this streamer (user-independent)
    const allCountPromise = needsAllCount
      ? supabaseAdminNoCache
          .from('cards')
          .select('id', { count: 'exact', head: true })
          .eq('streamer_id', streamer.id)
          .eq('is_active', true)
      : null;

    // {num} / {unique} は RPC `get_user_card_counts` で DB 側 GROUP BY 済みの
    // ユーザー所持カード一覧を取得して求める（PostgREST の行数制限を根本的に回避）
    // is_active フィルタは RPC が行わないため、ここでは JS 側で行う
    // {num} / {unique}: use RPC returning pre-aggregated per-card counts.
    // The RPC handles GROUP BY server-side, avoiding PostgREST 1000-row cap.
    // RPC does not filter by is_active, so we filter on the client.
    const userCardCountsPromise = (needsCardCount || needsUniqueCount || needsNewCardInfo)
      ? supabaseAdminNoCache.rpc('get_user_card_counts', {
          p_twitch_user_id: userId,
          p_streamer_id: streamer.id,
        })
      : null;

    // transient な transport / runtime 例外が throw されるとチャット通知全体が
    // 飛んでしまうため、Promise.all を try/catch で囲みフォールバック挙動を担保する。
    // PostgREST の `error` payload は下の if で個別にハンドリングする。
    // Wrap the Promise.all so transient transport/runtime rejections don't abort
    // the whole chat announcement. PostgREST `error` payloads are still handled below.
    try {
      const [allCountResult, userCardCountsResult] = await Promise.all([
        allCountPromise,
        userCardCountsPromise,
      ]);

      if (needsAllCount) {
        if (allCountResult?.error) {
          logger.warn('Failed to fetch {all} card count for chat announcement', {
            streamerId: streamer.id,
            error: allCountResult.error.message,
          });
        } else {
          allCount = allCountResult?.count ?? 0;
        }
      }

      if (needsCardCount || needsUniqueCount || needsNewCardInfo) {
        if (userCardCountsResult?.error) {
          logger.warn('Failed to fetch user card counts for chat announcement', {
            streamerId: streamer.id,
            userTwitchId: userId,
            error: userCardCountsResult.error.message,
          });
          if (needsUniqueCount || needsNewCardInfo) {
            // RPC 失敗時は 0 にフォールバックせず、未定義のままプレースホルダを空文字化
            // On RPC failure, leave placeholders undefined so buildMessage strips them
          }
        } else {
          // RPC は JSONB 配列を返し、各要素は { count, card: {..., is_active, id}, streamer }
          // RPC returns a JSONB array; each row holds { count, card: {...}, streamer }
          const rows = (userCardCountsResult?.data ?? []) as Array<{
            count: number;
            card: { id: string; is_active: boolean };
          }>;

          if (needsCardCount) {
            // 現在当選したカードの所持数を検索
            // Find the count for the card that just dropped
            const currentCardRow = rows.find((row) => row.card?.id === card.id);
            cardCount = currentCardRow?.count ?? 0;
          }

          if (needsUniqueCount) {
            // アクティブカードのみ数えてコンプ進捗を算出
            // Count only active cards to match the progress definition in dashboard UI
            uniqueCount = rows.filter((row) => row.card?.is_active === true).length;
          }

          if (needsNewCardInfo) {
            newCardNames = findNewCardNamesForCurrentDraw(drawnCards, rows);
          }
        }
      }
    } catch (err) {
      // transient 失敗時はプレースホルダを未定義のまま残し、通知は送信する
      // On transient failure, leave placeholders undefined and still send the announcement
      logger.warn('Chat announcement count queries threw; falling back to empty placeholders', {
        streamerId: streamer.id,
        userTwitchId: userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // コレクションページURLを構築
  // Build collection page URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://twica.live';
  const collectionUrl = `${baseUrl}/collection/${streamer.id}`;

  // メッセージのプレースホルダーを構築
  // Build message placeholders
  const placeholders: ChatMessagePlaceholders = {
    user: userName,
    card: card.name,
    cards: isMultiDraw && streamer.chat_announcement_multi_show_cards
      ? cardNames.join(CARD_LIST_SEPARATOR)
      : undefined,
    draws: isMultiDraw ? drawnCards.length : undefined,
    rarityCounts: isMultiDraw ? rarityCounts : undefined,
    newCards: needsNewCardInfo && newCardNames.length > 0
      ? newCardNames.join(CARD_LIST_SEPARATOR)
      : undefined,
    newCardCount: needsNewCardInfo ? newCardNames.length : undefined,
    rarity: rarityMap[card.rarity] || card.rarity,
    detail: card.description || undefined,
    num: cardCount,
    unique: uniqueCount,
    all: allCount,
    url: collectionUrl,
  };

  // チャットサービスでメッセージを構築・送信
  // Build and send message using chat service
  const chatService = new TwitchChatService();
  let message: string;

  // 後段で「初出: {cardNames}」を追記する場合、{cards} 側の圧縮時に
  // 接尾辞分の文字数を予約しておかないと、最終的な truncate で「初出:」部分が
  // 切り落とされる可能性がある。事前に長さを見積もって reservedSuffixCharacters に渡す。
  // Estimate the suffix length so {cards} fitting reserves space for the appended "初出: ..."
  const willAppendDefaultNewCards = shouldAppendDefaultNewCards && newCardNames.length > 0;
  const reservedSuffixCharacters = willAppendDefaultNewCards
    ? countCharacters(' 初出: ') + countCharacters(newCardNames.join(CARD_LIST_SEPARATOR))
    : 0;

  if (isMultiDraw && streamer.chat_announcement_multi_show_cards && usesMultiDrawPlaceholders) {
    const fitted = fitCardNamesForMessage(
      cardNames,
      (cardsText) => chatService.buildMessage(messageTemplate, { ...placeholders, cards: cardsText }),
      reservedSuffixCharacters
    );
    placeholders.cards = fitted.cardsText;
    message = fitted.message;
  } else {
    const baseMessage = chatService.buildMessage(messageTemplate, placeholders);
    if (isMultiDraw && streamer.chat_announcement_multi_show_cards && !usesMultiDrawPlaceholders) {
      message = fitCardNamesForMessage(
        cardNames,
        (cardsText) => `${baseMessage}（全${drawnCards.length}枚: ${cardsText}）`,
        reservedSuffixCharacters
      ).message;
    } else {
      message = baseMessage;
    }
  }

  if (willAppendDefaultNewCards) {
    // ここでの fitCardNamesForMessage は newCardNames 側の圧縮を担う。
    // 上で {cards} 側に余白を予約済みなので、通常はここでの圧縮は発生しない。
    // The earlier pass reserved space, so this fit normally just appends as-is.
    const fitted = fitCardNamesForMessage(
      newCardNames,
      (newCardsText) => `${message} 初出: ${newCardsText}`
    );
    message = fitted.message;
  }

  const success = await chatService.sendChatMessage(broadcasterTwitchUserId, message);

  if (success) {
    logger.info('Chat announcement sent', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
      drawCount: drawnCards.length,
      multiDraw: isMultiDraw,
    });
  } else {
    // sendChatMessage が false を返した場合のログ（API呼び出し失敗）
    // Log when sendChatMessage returns false (API call failure)
    logger.warn('Chat announcement failed - sendChatMessage returned false', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
      drawCount: drawnCards.length,
      multiDraw: isMultiDraw,
    });
  }
}
