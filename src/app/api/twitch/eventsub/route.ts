import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, getSupabaseAdminNoCache } from "@/lib/supabase/admin";
import { GachaService } from "@/lib/services/gacha";
import { TWITCH_SUBSCRIPTION_TYPE, ERROR_MESSAGES } from "@/lib/constants";
import { handleApiError } from "@/lib/error-handler";
import { broadcastGachaResult } from "@/lib/realtime";
import { checkRateLimit, rateLimits, getClientIp } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { reportError } from "@/lib/sentry/error-handler";
import { TwitchChatService, type ChatMessagePlaceholders } from "@/lib/twitch/chat-service";
import { hasScope } from "@/lib/twitch/token-manager";
import { ADDITIONAL_SCOPES } from "@/lib/twitch/auth";
import type { GachaCard } from "@/lib/services/gacha";

const MESSAGE_TYPE_VERIFICATION = "webhook_callback_verification";
const MESSAGE_TYPE_NOTIFICATION = "notification";
const MESSAGE_TYPE_REVOCATION = "revocation";

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
      await handleRedemption(messageId, event);
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

    logger.warn(
      `EventSub revocation received: reason=${revocationReason}, type=${subscriptionType}, broadcaster=${broadcasterId}`,
      { subscription }
    );

    // Sentryにも報告して追跡可能にする
    reportError(new Error(`EventSub revocation: ${revocationReason}`), {
      context: "EventSub Revocation",
      type: "eventsub",
      revocationReason,
      subscriptionType,
      broadcasterId,
      subscriptionId: subscription?.id,
    });

    return NextResponse.json({ received: true });
  }

  return NextResponse.json({ error: ERROR_MESSAGES.UNKNOWN_MESSAGE_TYPE }, { status: 400 });
}

async function handleRedemption(messageId: string, event: {
  broadcaster_user_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  reward: { id: string; title: string };
}) {
  // handleRedemption開始ログ（デバッグ：この関数が呼ばれたことを確認）
  logger.info('[handleRedemption] START', {
    messageId,
    broadcasterUserId: event.broadcaster_user_id,
    userName: event.user_name,
    rewardTitle: event.reward.title,
  });

  const supabaseAdmin = getSupabaseAdmin();

  // Idempotency check - skip if this event was already processed
  // 冪等性チェック：既に処理済みのイベントはスキップ
  const { data: existingHistory } = await supabaseAdmin
    .from('gacha_history')
    .select('id')
    .eq('event_id', messageId)
    .single();

  if (existingHistory) {
    logger.info('[handleRedemption] Skipped - already processed', { messageId });
    return;
  }

  try {
    const gachaService = new GachaService();
    const result = await gachaService.executeGachaForEventSub(event, messageId);

    if (!result.success) {
      // Error in gacha but don't throw, as webhook should return 200
      // ガチャでエラーが発生してもthrowしない。webhookは200を返す必要がある
      logger.warn('[handleRedemption] Gacha execution failed', { messageId });
      return;
    }

    logger.info('[handleRedemption] Gacha success', {
      messageId,
      cardName: result.data.card.name,
    });

    // Notify overlay via Supabase Realtime
    // Supabase Realtimeを通じてオーバーレイに通知
    const gachaResult = {
      type: "gacha" as const,
      card: result.data.card,
      userTwitchUsername: result.data.userTwitchUsername,
    };

    // Get streamer data for broadcast and chat announcement settings
    // Use no-cache client to ensure settings changes are reflected immediately
    // ブロードキャスト用とチャット通知設定用にストリーマーデータを取得
    // 設定変更が即座に反映されるようキャッシュ無効クライアントを使用
    const supabaseAdminNoCache = getSupabaseAdminNoCache();
    const { data: streamer, error: streamerError } = await supabaseAdminNoCache
      .from("streamers")
      .select("id, chat_announcement_enabled, chat_announcement_template")
      .eq("twitch_user_id", event.broadcaster_user_id)
      .single();

    logger.info('[handleRedemption] Streamer query result', {
      found: !!streamer,
      streamerId: streamer?.id,
      chatAnnouncementEnabled: streamer?.chat_announcement_enabled,
      error: streamerError?.message,
    });

    if (streamer) {
      // Realtime通知（既存機能）
      await broadcastGachaResult(streamer.id, gachaResult, {
        maxRetries: 3,
        retryDelay: 1000,
      });

      logger.info('[handleRedemption] Broadcast done, starting chat announcement', {
        streamerId: streamer.id,
      });

      // チャット通知 - awaitで完了を待つ（Cloudflare Workersではレスポンス返却後に
      // バックグラウンドPromiseが打ち切られるため、fire-and-forgetは使えない）
      // Chat announcement - must await because Cloudflare Workers terminates
      // background promises after response is sent (no waitUntil available)
      try {
        await sendChatAnnouncement(
          event.broadcaster_user_id,
          streamer,
          result.data.card,
          event.user_name,
          event.user_id
        );
        logger.info('[handleRedemption] Chat announcement completed');
      } catch (err) {
        // チャット送信失敗はログのみ、ガチャ処理はブロックしない
        // Chat send failure is logged only, does not block gacha processing
        logger.warn('[handleRedemption] Chat announcement threw error', {
          error: err instanceof Error ? err.message : String(err),
          broadcasterTwitchUserId: event.broadcaster_user_id,
          streamerId: streamer.id,
        });
      }
    }

    logger.info('[handleRedemption] END', { messageId });
  } catch (error) {
    logger.error('[handleRedemption] Unhandled error', {
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return handleApiError(error, "EventSub redemption");
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
 */
async function sendChatAnnouncement(
  broadcasterTwitchUserId: string,
  streamer: {
    id: string;
    chat_announcement_enabled: boolean;
    chat_announcement_template: string | null;
  },
  card: GachaCard,
  userName: string,
  userId: string
): Promise<void> {
  // 関数呼び出しを記録（デバッグ用：この関数が呼ばれたことを確認するため）
  // Log function entry to confirm this function is being called
  logger.info('sendChatAnnouncement called', {
    broadcasterTwitchUserId,
    streamerId: streamer.id,
    chatAnnouncementEnabled: streamer.chat_announcement_enabled,
    cardName: card.name,
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

  // user:write:chatスコープが付与されているかチェック
  // Check if user:write:chat scope is granted
  const hasChatScope = await hasScope(broadcasterTwitchUserId, ADDITIONAL_SCOPES.CHAT_WRITE);
  if (!hasChatScope) {
    logger.info('Chat announcement skipped - missing scope', {
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

  // ユーザーがこのカードを何枚所持しているか取得（オプション）
  // Get how many of this card the user owns (optional)
  // Use no-cache client to ensure fresh data after gacha execution
  // ガチャ実行後の最新データを取得するためキャッシュ無効クライアントを使用
  const supabaseAdminNoCache = getSupabaseAdminNoCache();
  let cardCount: number | undefined;
  try {
    // usersテーブルからユーザーIDを取得
    const { data: user } = await supabaseAdminNoCache
      .from('users')
      .select('id')
      .eq('twitch_user_id', userId)
      .single();

    if (user) {
      // user_cardsテーブルから所持枚数を取得
      const { count } = await supabaseAdminNoCache
        .from('user_cards')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('card_id', card.id);

      cardCount = count ?? undefined;
    }
  } catch {
    // カウント取得失敗は無視
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
    rarity: rarityMap[card.rarity] || card.rarity,
    detail: card.description || undefined,
    num: cardCount,
    url: collectionUrl,
  };

  // チャットサービスでメッセージを構築・送信
  // Build and send message using chat service
  const chatService = new TwitchChatService();
  const message = chatService.buildMessage(streamer.chat_announcement_template, placeholders);

  const success = await chatService.sendChatMessage(broadcasterTwitchUserId, message);

  if (success) {
    logger.info('Chat announcement sent', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
    });
  } else {
    // sendChatMessage が false を返した場合のログ（API呼び出し失敗）
    // Log when sendChatMessage returns false (API call failure)
    logger.warn('Chat announcement failed - sendChatMessage returned false', {
      broadcasterTwitchUserId,
      streamerId: streamer.id,
      cardName: card.name,
    });
  }
}
